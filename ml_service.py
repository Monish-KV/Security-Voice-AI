#!/usr/bin/env python3

"""
VoiceShield AI - Model Inference Service

Primary trained models:
    models/audio_deepfake_v2.keras
    models/audio_deepfake_v4.keras

Important model semantics:
    The trained models output REAL-VOICE probability.

    Therefore:

        deepfake_probability = 1 - real_voice_probability

The application exposes the converted deepfake/spoof score to the
security layer and frontend.

Audio pipeline:
    input audio
        ↓
    FFmpeg decode
        ↓
    16 kHz mono
        ↓
    3-second windows
        ↓
    1-second hop
        ↓
    128 Mel bins
        ↓
    65 time steps
        ↓
    V2 + V4 inference
        ↓
    50/50 ensemble

This service runs locally on port 5001 and is called by server.js.
"""

import os
import sys
import json
import time
import errno
import subprocess
import traceback
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler


# ---------------------------------------------------------------------------
# SERVICE STARTUP
# ---------------------------------------------------------------------------

def is_service_already_running(port):
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/health"
        )

        with urllib.request.urlopen(
            request,
            timeout=1.0
        ) as response:

            return response.status == 200

    except Exception:
        return False


TARGET_PORT = (
    int(sys.argv[1])
    if len(sys.argv) > 1
    else 5001
)


if is_service_already_running(TARGET_PORT):

    print(
        f"[ML Service] Service is already active "
        f"and healthy on port {TARGET_PORT}. "
        f"Exiting cleanly."
    )

    sys.exit(0)


# ---------------------------------------------------------------------------
# NUMERICAL / ML IMPORTS
# ---------------------------------------------------------------------------

# Reduce TensorFlow console noise.
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

# Force Keras to use TensorFlow backend.
os.environ["KERAS_BACKEND"] = "tensorflow"


import numpy as np
import scipy.signal
from librosa.filters import mel as librosa_mel
import keras


# ---------------------------------------------------------------------------
# MODEL PATHS
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(
    os.path.abspath(__file__)
)


MODEL_V2_PATH = os.path.join(
    BASE_DIR,
    "models",
    "audio_deepfake_v2.keras"
)


MODEL_V4_PATH = os.path.join(
    BASE_DIR,
    "models",
    "audio_deepfake_v4.keras"
)


# ---------------------------------------------------------------------------
# LOAD MODELS
# ---------------------------------------------------------------------------

print(
    f"[ML Service] Loading V2 from {MODEL_V2_PATH}..."
)

model_v2 = keras.models.load_model(
    MODEL_V2_PATH
)

print(
    "[ML Service] V2 loaded: "
    f"input={model_v2.input_shape}, "
    f"output={model_v2.output_shape}"
)


print(
    f"[ML Service] Loading V4 from {MODEL_V4_PATH}..."
)

model_v4 = keras.models.load_model(
    MODEL_V4_PATH
)

print(
    "[ML Service] V4 loaded: "
    f"input={model_v4.input_shape}, "
    f"output={model_v4.output_shape}"
)


# ---------------------------------------------------------------------------
# AUDIO CONFIGURATION
# ---------------------------------------------------------------------------

SR = 16000

WINDOW_SECONDS = 3

HOP_SECONDS = 1

N_FFT = 1024

HOP_LENGTH = 750

N_MELS = 128

MAX_TIME_STEPS = 65


# ---------------------------------------------------------------------------
# MEL FILTER BANK
# ---------------------------------------------------------------------------

MEL_FB = librosa_mel(
    sr=SR,
    n_fft=N_FFT,
    n_mels=N_MELS
)


# ---------------------------------------------------------------------------
# MODEL WARMUP
# ---------------------------------------------------------------------------

_dummy = np.zeros(
    (
        1,
        N_MELS,
        MAX_TIME_STEPS,
        1
    ),
    dtype=np.float32
)


model_v2.predict(
    _dummy,
    verbose=0
)


model_v4.predict(
    _dummy,
    verbose=0
)


print(
    "[ML Service] Model warmup completed successfully."
)


# ---------------------------------------------------------------------------
# AUDIO DECODING
# ---------------------------------------------------------------------------

def decode_audio(
    audio_bytes,
    ext="wav"
):
    """
    Decode arbitrary supported audio bytes into:

        16 kHz
        mono
        float32

    FFmpeg performs the format conversion.
    """

    command = [
        "ffmpeg",

        "-v",
        "error",

        "-i",
        "pipe:0",

        "-ar",
        str(SR),

        "-ac",
        "1",

        "-f",
        "f32le",

        "pipe:1"
    ]


    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )


    output,
    error = process.communicate(
        input=audio_bytes
    )


    if (
        process.returncode != 0
        or len(output) == 0
    ):

        error_text = error.decode(
            "utf-8",
            errors="ignore"
        )


        raise ValueError(
            "FFmpeg failed to decode audio: "
            + error_text
        )


    audio = np.frombuffer(
        output,
        dtype=np.float32
    )


    # Remove NaN / infinite values from
    # malformed input before ML processing.
    audio = np.nan_to_num(
        audio,
        nan=0.0,
        posinf=0.0,
        neginf=0.0
    )


    return audio.astype(
        np.float32
    )


# ---------------------------------------------------------------------------
# FEATURE EXTRACTION
# ---------------------------------------------------------------------------

def extract_features(
    audio_slice
):
    """
    Convert one audio segment into:

        (128, 65, 1)

    mel-spectrogram representation.
    """

    target_samples = (
        SR * WINDOW_SECONDS
    )


    # Pad shorter recordings/windows.
    if len(audio_slice) < target_samples:

        audio_slice = np.pad(
            audio_slice,
            (
                0,
                target_samples
                - len(audio_slice)
            ),
            mode="constant"
        )


    # Truncate longer recordings/windows.
    elif len(audio_slice) > target_samples:

        audio_slice = audio_slice[
            :target_samples
        ]


    # Protect against invalid numerical values.
    audio_slice = np.nan_to_num(
        audio_slice,
        nan=0.0,
        posinf=0.0,
        neginf=0.0
    )


    # Keep waveform within normal audio range.
    audio_slice = np.clip(
        audio_slice,
        -1.0,
        1.0
    )


    # -----------------------------------------------------------------------
    # STFT
    # -----------------------------------------------------------------------

    frequencies,
    times,
    stft = scipy.signal.stft(
        audio_slice,
        fs=SR,
        nperseg=N_FFT,
        noverlap=N_FFT - HOP_LENGTH
    )


    power = (
        np.abs(stft) ** 2
    )


    # -----------------------------------------------------------------------
    # MEL SPECTROGRAM
    # -----------------------------------------------------------------------

    mel_spec = np.dot(
        MEL_FB,
        power
    )


    # -----------------------------------------------------------------------
    # FORCE EXACTLY 65 TIME STEPS
    # -----------------------------------------------------------------------

    if mel_spec.shape[1] > MAX_TIME_STEPS:

        mel_spec = mel_spec[
            :,
            :MAX_TIME_STEPS
        ]


    elif mel_spec.shape[1] < MAX_TIME_STEPS:

        mel_spec = np.pad(
            mel_spec,
            (
                (
                    0,
                    0
                ),
                (
                    0,
                    MAX_TIME_STEPS
                    - mel_spec.shape[1]
                )
            ),
            mode="constant"
        )


    # -----------------------------------------------------------------------
    # CONVERT TO dB
    # -----------------------------------------------------------------------

    mel_spec = np.nan_to_num(
        mel_spec,
        nan=0.0,
        posinf=0.0,
        neginf=0.0
    )


    reference = np.max(
        mel_spec
    )


    safe_reference = max(
        float(reference),
        1e-10
    )


    mel_db = (
        10.0
        * np.log10(
            np.maximum(
                mel_spec,
                1e-10
            )
        )
        -
        10.0
        * np.log10(
            safe_reference
        )
    )


    mel_db = np.nan_to_num(
        mel_db,
        nan=0.0,
        posinf=0.0,
        neginf=0.0
    )


    return mel_db[
        :,
        :,
        np.newaxis
    ].astype(
        np.float32
    )


# ---------------------------------------------------------------------------
# MODEL OUTPUT VALIDATION
# ---------------------------------------------------------------------------

def extract_model_probability(
    prediction,
    model_name
):
    """
    Extract one scalar probability from a Keras prediction.

    The model output is interpreted as:

        REAL VOICE PROBABILITY
    """

    values = np.asarray(
        prediction,
        dtype=np.float64
    ).reshape(-1)


    if len(values) == 0:

        raise ValueError(
            f"{model_name} returned an empty prediction."
        )


    value = float(
        values[0]
    )


    if not np.isfinite(value):

        raise ValueError(
            f"{model_name} returned a non-finite prediction."
        )


    # Models producing probabilities should
    # remain inside [0, 1].
    if value < 0.0 or value > 1.0:

        raise ValueError(
            f"{model_name} returned an invalid probability: {value}"
        )


    return value


# ---------------------------------------------------------------------------
# AUDIO ANALYSIS
# ---------------------------------------------------------------------------

def analyze_audio(
    audio_bytes,
    ext="wav"
):
    """
    Run complete V2 + V4 inference.

    IMPORTANT:

    Keras output:
        REAL probability

    Converted score:
        DEEPFAKE probability = 1 - REAL probability
    """

    started = time.time()


    # -----------------------------------------------------------------------
    # DECODE
    # -----------------------------------------------------------------------

    audio = decode_audio(
        audio_bytes,
        ext
    )


    duration = (
        float(len(audio))
        / float(SR)
    )


    if duration < 0.3:

        raise ValueError(
            "Audio recording is too short "
            "(less than 0.3 seconds)."
        )


    # -----------------------------------------------------------------------
    # BASIC AUDIO QUALITY CHECK
    # -----------------------------------------------------------------------

    rms = float(
        np.sqrt(
            np.mean(
                audio ** 2
            )
        )
    )


    if not np.isfinite(rms):

        raise ValueError(
            "Audio quality validation failed."
        )


    if rms < 0.0001:

        raise ValueError(
            "INSUFFICIENT SPEECH: "
            "Audio is completely silent or muted."
        )


    # -----------------------------------------------------------------------
    # CREATE 3-SECOND WINDOWS
    # -----------------------------------------------------------------------

    window_samples = (
        SR * WINDOW_SECONDS
    )


    hop_samples = (
        SR * HOP_SECONDS
    )


    slices = []

    starts = []

    ends = []


    if len(audio) <= window_samples:

        slices.append(
            extract_features(
                audio
            )
        )


        starts.append(
            0.0
        )


        ends.append(
            round(
                duration,
                2
            )
        )


    else:

        for start_idx in range(
            0,
            len(audio)
            - window_samples // 2,
            hop_samples
        ):

            end_idx = min(
                start_idx
                + window_samples,
                len(audio)
            )


            slice_data = audio[
                start_idx:end_idx
            ]


            slices.append(
                extract_features(
                    slice_data
                )
            )


            start_seconds = (
                start_idx
                / SR
            )


            end_seconds = min(
                start_seconds
                + WINDOW_SECONDS,
                duration
            )


            starts.append(
                round(
                    start_seconds,
                    2
                )
            )


            ends.append(
                round(
                    end_seconds,
                    2
                )
            )


    if not slices:

        raise ValueError(
            "No usable analysis windows were created."
        )


    batch = np.stack(
        slices,
        axis=0
    )


    # -----------------------------------------------------------------------
    # REAL MODEL INFERENCE
    # -----------------------------------------------------------------------

    raw_v2 = model_v2.predict(
        batch,
        verbose=0
    )


    raw_v4 = model_v4.predict(
        batch,
        verbose=0
    )


    preds_v2 = np.asarray(
        raw_v2,
        dtype=np.float64
    ).reshape(-1)


    preds_v4 = np.asarray(
        raw_v4,
        dtype=np.float64
    ).reshape(-1)


    if len(preds_v2) != len(slices):

        raise ValueError(
            "V2 prediction count does not match "
            "the number of audio windows."
        )


    if len(preds_v4) != len(slices):

        raise ValueError(
            "V4 prediction count does not match "
            "the number of audio windows."
        )


    # -----------------------------------------------------------------------
    # CONVERT REAL PROBABILITY → DEEPFAKE PROBABILITY
    # -----------------------------------------------------------------------

    deepfake_v2 = []

    deepfake_v4 = []


    for value in preds_v2:

        real_probability = (
            extract_model_probability(
                value,
                "V2"
            )
        )


        deepfake_probability = (
            1.0
            - real_probability
        )


        deepfake_v2.append(
            deepfake_probability
        )


    for value in preds_v4:

        real_probability = (
            extract_model_probability(
                value,
                "V4"
            )
        )


        deepfake_probability = (
            1.0
            - real_probability
        )


        deepfake_v4.append(
            deepfake_probability
        )


    deepfake_v2 = np.asarray(
        deepfake_v2,
        dtype=np.float64
    )


    deepfake_v4 = np.asarray(
        deepfake_v4,
        dtype=np.float64
    )


    # -----------------------------------------------------------------------
    # 50/50 ENSEMBLE
    # -----------------------------------------------------------------------

    ensemble_deepfake = (
        0.50 * deepfake_v2
        +
        0.50 * deepfake_v4
    )


    # -----------------------------------------------------------------------
    # TIMELINE
    # -----------------------------------------------------------------------

    timeline = []


    for i in range(
        len(slices)
    ):

        v2_score = (
            float(
                deepfake_v2[i]
            )
            * 100.0
        )


        v4_score = (
            float(
                deepfake_v4[i]
            )
            * 100.0
        )


        ensemble_score = (
            float(
                ensemble_deepfake[i]
            )
            * 100.0
        )


        if ensemble_score >= 70.0:

            status = "HIGH"

        elif ensemble_score >= 40.0:

            status = "ELEVATED"

        else:

            status = "CLEAR"


        timeline.append(
            {
                "start_seconds":
                    starts[i],

                "end_seconds":
                    ends[i],

                "v2_score":
                    round(
                        v2_score,
                        2
                    ),

                "v4_score":
                    round(
                        v4_score,
                        2
                    ),

                "ensemble_score":
                    round(
                        ensemble_score,
                        2
                    ),

                "status":
                    status,
            }
        )


    # -----------------------------------------------------------------------
    # OVERALL SCORES
    # -----------------------------------------------------------------------

    avg_v2_deepfake = float(
        np.mean(
            deepfake_v2
        )
    )


    avg_v4_deepfake = float(
        np.mean(
            deepfake_v4
        )
    )


    avg_v2_real = (
        1.0
        - avg_v2_deepfake
    )


    avg_v4_real = (
        1.0
        - avg_v4_deepfake
    )


    v2_score = round(
        avg_v2_deepfake * 100.0,
        2
    )


    v4_score = round(
        avg_v4_deepfake * 100.0,
        2
    )


    ensemble_score = round(
        (
            v2_score
            + v4_score
        )
        / 2.0,
        2
    )


    # -----------------------------------------------------------------------
    # FINAL NUMERICAL SAFETY CHECK
    # -----------------------------------------------------------------------

    numeric_values = [
        duration,
        v2_score,
        v4_score,
        ensemble_score,
        avg_v2_deepfake,
        avg_v4_deepfake,
        avg_v2_real,
        avg_v4_real,
    ]


    if not all(
        np.isfinite(value)
        for value in numeric_values
    ):

        raise ValueError(
            "Inference produced a non-finite value."
        )


    # -----------------------------------------------------------------------
    # PROCESSING TIME
    # -----------------------------------------------------------------------

    process_time = round(
        time.time() - started,
        3
    )


    # -----------------------------------------------------------------------
    # RETURN CONTRACT
    # -----------------------------------------------------------------------

    return {

        "duration_seconds":
            round(
                duration,
                2
            ),

        # These are the scores consumed
        # by server.js as DEEPFAKE scores.
        "v2_score":
            v2_score,

        "v4_score":
            v4_score,

        "ensemble_score":
            ensemble_score,


        # Explicit semantic fields.
        "v2_deepfake_probability":
            round(
                avg_v2_deepfake,
                6
            ),

        "v2_real_voice_probability":
            round(
                avg_v2_real,
                6
            ),

        "v4_deepfake_probability":
            round(
                avg_v4_deepfake,
                6
            ),

        "v4_real_voice_probability":
            round(
                avg_v4_real,
                6
            ),


        "timeline":
            timeline,


        "processing_time":
            process_time,


        "inference_source":
            "genuine_keras_models",


        "model_semantics":
            "V2 and V4 raw outputs represent real-voice probability; deepfake score is 1 minus the model output.",


        "ensemble_method":
            "50/50 arithmetic mean of V2 and V4 deepfake probabilities.",


        "v2_model_path":
            "models/audio_deepfake_v2.keras",


        "v4_model_path":
            "models/audio_deepfake_v4.keras",

    }


# ---------------------------------------------------------------------------
# HTTP REQUEST HANDLER
# ---------------------------------------------------------------------------

class MLRequestHandler(
    BaseHTTPRequestHandler
):

    def log_message(
        self,
        format,
        *args
    ):

        sys.stderr.write(
            "[ML Service] "
            + (
                format % args
            )
            + "\n"
        )


    # -----------------------------------------------------------------------
    # HEALTH
    # -----------------------------------------------------------------------

    def do_GET(self):

        if self.path == "/health":

            self.send_response(
                200
            )


            self.send_header(
                "Content-Type",
                "application/json"
            )


            self.end_headers()


            payload = {

                "status":
                    "online",

                "v2_loaded":
                    True,

                "v4_loaded":
                    True,

                "tensorflow_available":
                    True,

                "keras_available":
                    True,

                "v2_input_shape":
                    list(
                        model_v2.input_shape
                    ),

                "v4_input_shape":
                    list(
                        model_v4.input_shape
                    ),

                "model_semantics":
                    "real_voice_probability",

                "deepfake_score_formula":
                    "1 - real_voice_probability",

            }


            self.wfile.write(
                json.dumps(
                    payload
                ).encode(
                    "utf-8"
                )
            )


            return


        self.send_response(
            404
        )


        self.end_headers()


    # -----------------------------------------------------------------------
    # PREDICTION
    # -----------------------------------------------------------------------

    def do_POST(self):

        if self.path != "/predict":

            self.send_response(
                404
            )


            self.end_headers()


            return


        try:

            content_length = int(
                self.headers.get(
                    "Content-Length",
                    0
                )
            )

        except (
            TypeError,
            ValueError
        ):

            content_length = 0


        if content_length <= 0:

            self.send_response(
                400
            )


            self.send_header(
                "Content-Type",
                "application/json"
            )


            self.end_headers()


            self.wfile.write(
                json.dumps(
                    {
                        "error":
                            "Empty audio body."
                    }
                ).encode(
                    "utf-8"
                )
            )


            return


        ext = self.headers.get(
            "X-Audio-Ext",
            "wav"
        ).lower()


        audio_bytes = (
            self.rfile.read(
                content_length
            )
        )


        try:

            result = analyze_audio(
                audio_bytes,
                ext
            )


            self.send_response(
                200
            )


            self.send_header(
                "Content-Type",
                "application/json"
            )


            self.end_headers()


            self.wfile.write(
                json.dumps(
                    result
                ).encode(
                    "utf-8"
                )
            )


        except Exception as error:

            error_message = str(
                error
            )


            traceback.print_exc()


            self.send_response(
                422
            )


            self.send_header(
                "Content-Type",
                "application/json"
            )


            self.end_headers()


            self.wfile.write(
                json.dumps(
                    {
                        "error":
                            error_message
                    }
                ).encode(
                    "utf-8"
                )
            )


# ---------------------------------------------------------------------------
# REUSABLE HTTP SERVER
# ---------------------------------------------------------------------------

class ReusableHTTPServer(
    HTTPServer
):

    allow_reuse_address = True


# ---------------------------------------------------------------------------
# SERVER START
# ---------------------------------------------------------------------------

def run_server(
    port=5001
):

    server_address = (
        "127.0.0.1",
        port
    )


    try:

        httpd = (
            ReusableHTTPServer(
                server_address,
                MLRequestHandler
            )
        )


    except OSError as error:

        if (
            error.errno
            == errno.EADDRINUSE
            or
            "Address already in use"
            in str(error)
        ):

            if is_service_already_running(
                port
            ):

                print(
                    "[ML Service] Port "
                    f"{port} is already active "
                    "with a healthy ML service. "
                    "Exiting cleanly."
                )

                sys.exit(0)


            print(
                "[ML Service] Port "
                f"{port} is already in use. "
                "Exiting cleanly."
            )

            sys.exit(0)


        raise


    print(
        "[ML Service] Serving genuine "
        "V2/V4 inference on "
        f"http://127.0.0.1:{port}"
    )


    try:

        httpd.serve_forever()


    except KeyboardInterrupt:

        print(
            "[ML Service] Shutting down."
        )


        httpd.server_close()


# ---------------------------------------------------------------------------
# ENTRY POINT
# ---------------------------------------------------------------------------

if __name__ == "__main__":

    port = (
        int(sys.argv[1])
        if len(sys.argv) > 1
        else 5001
    )


    run_server(
        port
    )