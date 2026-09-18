#!/usr/bin/env python3
"""
VoiceShield AI - Model Inference Service
Loads genuine trained models:
 - models/audio_deepfake_v2.keras
 - models/audio_deepfake_v4.keras
Performs real audio decoding and preprocessing (16kHz, 3s windows, 1s hop, 128 mel bins, 65 frames max).
Serves HTTP requests on a local internal port (default 5001) for the main application.
"""

import os
import sys
import json
import time
import io
import errno
import subprocess
import traceback
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

def is_service_already_running(port):
    try:
        req = urllib.request.Request(f'http://127.0.0.1:{port}/health')
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            if resp.status == 200:
                return True
    except Exception:
        pass
    return False

TARGET_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
if is_service_already_running(TARGET_PORT):
    print(f"[ML Service] Service is already active and healthy on port {TARGET_PORT}. Exiting cleanly.")
    sys.exit(0)

import numpy as np
import scipy.signal
from librosa.filters import mel as librosa_mel

# Suppress TF verbose logging
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
os.environ['KERAS_BACKEND'] = 'tensorflow'

import keras

MODEL_V2_PATH = os.path.join(os.path.dirname(__file__), 'models', 'audio_deepfake_v2.keras')
MODEL_V4_PATH = os.path.join(os.path.dirname(__file__), 'models', 'audio_deepfake_v4.keras')

print(f"[ML Service] Loading V2 from {MODEL_V2_PATH}...")
model_v2 = keras.models.load_model(MODEL_V2_PATH)
print(f"[ML Service] V2 loaded: input={model_v2.input_shape}, output={model_v2.output_shape}")

print(f"[ML Service] Loading V4 from {MODEL_V4_PATH}...")
model_v4 = keras.models.load_model(MODEL_V4_PATH)
print(f"[ML Service] V4 loaded: input={model_v4.input_shape}, output={model_v4.output_shape}")

# Precompute 16kHz mel filterbank
SR = 16000
N_FFT = 1024
HOP_LENGTH = 750  # 48000 samples / 750 = 65 frames (matches max 65 time steps)
N_MELS = 128
MEL_FB = librosa_mel(sr=SR, n_fft=N_FFT, n_mels=N_MELS)

# Warm up models
_dummy = np.zeros((1, 128, 65, 1), dtype=np.float32)
model_v2.predict(_dummy, verbose=0)
model_v4.predict(_dummy, verbose=0)
print("[ML Service] Warmup completed successfully.")


def decode_audio(audio_bytes, ext='wav'):
    """Decode audio bytes to 16kHz mono float32 numpy array using ffmpeg."""
    cmd = [
        'ffmpeg', '-v', 'error',
        '-i', 'pipe:0',
        '-ar', str(SR),
        '-ac', '1',
        '-f', 'f32le',
        'pipe:1'
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = proc.communicate(input=audio_bytes)
    if proc.returncode != 0 or len(out) == 0:
        raise ValueError(f"ffmpeg failed to decode audio: {err.decode('utf-8', errors='ignore')}")
    audio = np.frombuffer(out, dtype=np.float32)
    return audio


def extract_features(audio_slice):
    """
    Extract (128, 65, 1) mel-spectrogram in dB from a 3-second (or padded) 16kHz audio slice.
    Target shape: (128, 65, 1)
    """
    target_samples = SR * 3  # 48,000 samples
    if len(audio_slice) < target_samples:
        # Pad with zeros or edge wrap
        audio_slice = np.pad(audio_slice, (0, target_samples - len(audio_slice)), mode='constant')
    elif len(audio_slice) > target_samples:
        audio_slice = audio_slice[:target_samples]

    f, t, Zxx = scipy.signal.stft(audio_slice, fs=SR, nperseg=N_FFT, noverlap=N_FFT - HOP_LENGTH)
    power = np.abs(Zxx) ** 2
    mel_spec = np.dot(MEL_FB, power)

    # Ensure exactly 65 time steps
    if mel_spec.shape[1] > 65:
        mel_spec = mel_spec[:, :65]
    elif mel_spec.shape[1] < 65:
        mel_spec = np.pad(mel_spec, ((0, 0), (0, 65 - mel_spec.shape[1])), mode='constant')

    ref = np.max(mel_spec)
    mel_db = 10.0 * np.log10(np.maximum(mel_spec, 1e-10)) - 10.0 * np.log10(max(ref, 1e-10))
    return mel_db[:, :, np.newaxis]  # (128, 65, 1)


def analyze_audio(audio_bytes, ext='wav'):
    """Full analysis pipeline using real V2 and V4 models."""
    t0 = time.time()
    audio = decode_audio(audio_bytes, ext)
    duration = float(len(audio)) / float(SR)

    if duration < 0.3:
        raise ValueError("Audio recording is too short (less than 0.3 seconds).")

    # Speech presence / energy check
    rms = float(np.sqrt(np.mean(audio ** 2)))
    if rms < 0.0001:
        # Virtually silent
        raise ValueError("INSUFFICIENT SPEECH: Audio is completely silent or muted.")

    # Slice into 3-second windows with 1-second hop
    window_samples = SR * 3
    hop_samples = SR * 1

    slices = []
    starts = []
    ends = []

    if len(audio) <= window_samples:
        slices.append(extract_features(audio))
        starts.append(0.0)
        ends.append(round(duration, 2))
    else:
        for start_idx in range(0, len(audio) - window_samples // 2, hop_samples):
            end_idx = min(start_idx + window_samples, len(audio))
            slice_data = audio[start_idx:end_idx]
            slices.append(extract_features(slice_data))
            starts.append(round(start_idx / SR, 2))
            ends.append(round(min(start_idx / SR + 3.0, duration), 2))

    batch = np.stack(slices, axis=0)  # (N, 128, 65, 1)

    # Genuine model inference
    preds_v2 = model_v2.predict(batch, verbose=0).flatten().tolist()
    preds_v4 = model_v4.predict(batch, verbose=0).flatten().tolist()

    # Timeline segments
    timeline = []
    for i in range(len(slices)):
        v2_val = round(float(preds_v2[i]) * 100.0, 2)
        v4_val = round(float(preds_v4[i]) * 100.0, 2)
        ens_val = round((v2_val + v4_val) / 2.0, 2)
        status = 'HIGH' if ens_val >= 70.0 else ('ELEVATED' if ens_val >= 40.0 else 'CLEAR')
        timeline.append({
            'start_seconds': starts[i],
            'end_seconds': ends[i],
            'v2_score': v2_val,
            'v4_score': v4_val,
            'ensemble_score': ens_val,
            'status': status,
        })

    # Overall scores: mean across time windows
    avg_v2_prob = float(np.mean(preds_v2))
    avg_v4_prob = float(np.mean(preds_v4))

    v2_score = round(avg_v2_prob * 100.0, 2)
    v4_score = round(avg_v4_prob * 100.0, 2)
    ensemble_score = round((v2_score + v4_score) / 2.0, 2)

    process_time = round(time.time() - t0, 3)

    return {
        'duration_seconds': round(duration, 2),
        'v2_score': v2_score,
        'v4_score': v4_score,
        'ensemble_score': ensemble_score,
        'v2_deepfake_probability': round(avg_v2_prob, 6),
        'v2_real_voice_probability': round(1.0 - avg_v2_prob, 6),
        'v4_deepfake_probability': round(avg_v4_prob, 6),
        'v4_real_voice_probability': round(1.0 - avg_v4_prob, 6),
        'timeline': timeline,
        'processing_time': process_time,
        'inference_source': 'genuine_keras_models',
        'v2_model_path': 'models/audio_deepfake_v2.keras',
        'v4_model_path': 'models/audio_deepfake_v4.keras',
    }


class MLRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Concise logging
        sys.stderr.write("[ML Service] " + (format % args) + "\n")

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            payload = {
                'status': 'online',
                'v2_loaded': True,
                'v4_loaded': True,
                'tensorflow_available': True,
                'keras_available': True,
                'v2_input_shape': list(model_v2.input_shape),
                'v4_input_shape': list(model_v4.input_shape),
            }
            self.wfile.write(json.dumps(payload).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/predict':
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length == 0:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'Empty body'}).encode('utf-8'))
                return

            ext = self.headers.get('X-Audio-Ext', 'wav').lower()
            audio_bytes = self.rfile.read(content_length)

            try:
                res = analyze_audio(audio_bytes, ext)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(res).encode('utf-8'))
            except Exception as e:
                err_msg = str(e)
                traceback.print_exc()
                self.send_response(422)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': err_msg}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()


class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True


def run_server(port=5001):
    server_address = ('127.0.0.1', port)
    try:
        httpd = ReusableHTTPServer(server_address, MLRequestHandler)
    except OSError as e:
        if e.errno == errno.EADDRINUSE or 'Address already in use' in str(e):
            if is_service_already_running(port):
                print(f"[ML Service] Port {port} is already active with a healthy ML service. Exiting cleanly.")
                sys.exit(0)
            else:
                print(f"[ML Service] Port {port} address already in use. Exiting cleanly.")
                sys.exit(0)
        raise
    print(f"[ML Service] Serving genuine V2/V4 inference on http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[ML Service] Shutting down.")
        httpd.server_close()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
    run_server(port)
