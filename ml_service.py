"""
VoiceShield AI — Python ML Inference Service

Responsibilities:
- Load the trained V2 and V4 TensorFlow/Keras models.
- Decode supported audio through ffmpeg.
- Convert audio to 16 kHz mono.
- Analyze audio in 3-second windows with 1-second hop.
- Generate 128-bin Mel spectrogram features.
- Run genuine model.predict() inference.
- Convert the models' REAL-VOICE probability into DEEPFAKE score.
- Return per-window evidence for explainability/evaluation.

IMPORTANT:
- V2/V4 model outputs are treated as REAL-VOICE probabilities.
- Deepfake score = 1 - REAL-VOICE probability.
- No random/heuristic/fake model scores are generated.
- Model agreement is a diagnostic signal, NOT accuracy or confidence.
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import scipy.signal
import librosa
import tensorflow as tf
from tensorflow import keras


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST = "127.0.0.1"
PORT = 5001

SAMPLE_RATE = 16000

WINDOW_SECONDS = 3.0
HOP_SECONDS = 1.0

WINDOW_SAMPLES = int(SAMPLE_RATE * WINDOW_SECONDS)
HOP_SAMPLES = int(SAMPLE_RATE * HOP_SECONDS)

N_FFT = 1024
HOP_LENGTH = 750
N_MELS = 128

MAX_TIME_STEPS = 65

MODEL_V2_PATH = Path("models/audio_deepfake_v2.keras")
MODEL_V4_PATH = Path("models/audio_deepfake_v4.keras")


# ---------------------------------------------------------------------------
# Global model state
# ---------------------------------------------------------------------------

model_v2 = None
model_v4 = None

model_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def finite_float(
    value: Any,
    name: str,
) -> float:
    """
    Convert a value to a finite float.

    Raises ValueError instead of allowing NaN/Infinity
    to enter the API response.
    """
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(
            f"{name} is not a valid numeric value."
        )

    if not math.isfinite(result):
        raise ValueError(
            f"{name} is not finite."
        )

    return result


def clamp_probability(value: float) -> float:
    """
    Clamp a probability into [0, 1].

    This does not create a score.
    It only protects the API contract against tiny
    numerical values outside the expected range.
    """
    value = finite_float(
        value,
        "probability",
    )

    return max(
        0.0,
        min(
            1.0,
            value,
        ),
    )


def deepfake_score_from_real_probability(
    real_probability: float,
) -> float:
    """
    Convert model REAL-VOICE probability into
    DEEPFAKE probability/score.

    Example:
        real = 0.80
        deepfake = 0.20
    """
    real_probability = clamp_probability(
        real_probability
    )

    return clamp_probability(
        1.0 - real_probability
    )


def score_100(probability: float) -> float:
    """
    Convert probability [0,1] to score [0,100].
    """
    probability = clamp_probability(
        probability
    )

    return probability * 100.0


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_models() -> None:
    """
    Load the trained V2 and V4 Keras models.

    The service must fail loudly if either trained model
    cannot be loaded. It must never replace a missing model
    with a heuristic or random implementation.
    """
    global model_v2
    global model_v4

    if not MODEL_V2_PATH.exists():
        raise FileNotFoundError(
            f"V2 model not found: {MODEL_V2_PATH}"
        )

    if not MODEL_V4_PATH.exists():
        raise FileNotFoundError(
            f"V4 model not found: {MODEL_V4_PATH}"
        )

    print(
        f"[ML] Loading V2 model: {MODEL_V2_PATH}",
        flush=True,
    )

    model_v2 = keras.models.load_model(
        MODEL_V2_PATH,
        compile=False,
    )

    print(
        f"[ML] Loading V4 model: {MODEL_V4_PATH}",
        flush=True,
    )

    model_v4 = keras.models.load_model(
        MODEL_V4_PATH,
        compile=False,
    )

    print(
        f"[ML] V2 input shape: {model_v2.input_shape}",
        flush=True,
    )

    print(
        f"[ML] V4 input shape: {model_v4.input_shape}",
        flush=True,
    )

    # Warm-up inference.
    dummy = np.zeros(
        (
            1,
            N_MELS,
            MAX_TIME_STEPS,
            1,
        ),
        dtype=np.float32,
    )

    with model_lock:
        model_v2.predict(
            dummy,
            verbose=0,
        )

        model_v4.predict(
            dummy,
            verbose=0,
        )

    print(
        "[ML] V2/V4 models loaded and warmed successfully.",
        flush=True,
    )


# ---------------------------------------------------------------------------
# Audio decoding
# ---------------------------------------------------------------------------

def decode_audio(
    audio_bytes: bytes,
) -> np.ndarray:
    """
    Decode arbitrary supported audio using ffmpeg.

    Output:
        float32 mono waveform at 16 kHz.
    """

    if not audio_bytes:
        raise ValueError(
            "Audio payload is empty."
        )

    process = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "f32le",
            "pipe:1",
        ],
        input=audio_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    if process.returncode != 0:
        error_message = (
            process.stderr
            .decode(
                "utf-8",
                errors="replace",
            )
            .strip()
        )

        raise ValueError(
            "Audio decoding failed"
            + (
                f": {error_message}"
                if error_message
                else "."
            )
        )

    if not process.stdout:
        raise ValueError(
            "Audio decoder returned no samples."
        )

    audio = np.frombuffer(
        process.stdout,
        dtype=np.float32,
    )

    if audio.size == 0:
        raise ValueError(
            "Decoded audio contains no samples."
        )

    audio = np.nan_to_num(
        audio,
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )

    if not np.any(
        np.abs(audio) > 1e-8
    ):
        raise ValueError(
            "Decoded audio contains no usable signal."
        )

    return audio.astype(
        np.float32,
        copy=False,
    )


# ---------------------------------------------------------------------------
# Audio preprocessing
# ---------------------------------------------------------------------------

def create_mel_features(
    audio_window: np.ndarray,
) -> np.ndarray:
    """
    Convert one 3-second audio window into the
    model input representation.

    Target shape:
        (128, 65, 1)
    """

    audio_window = np.asarray(
        audio_window,
        dtype=np.float32,
    )

    audio_window = np.nan_to_num(
        audio_window,
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )

    # Ensure exactly the expected window length.
    if len(audio_window) < WINDOW_SAMPLES:
        audio_window = np.pad(
            audio_window,
            (
                0,
                WINDOW_SAMPLES
                - len(audio_window),
            ),
            mode="constant",
        )

    elif len(audio_window) > WINDOW_SAMPLES:
        audio_window = audio_window[
            :WINDOW_SAMPLES
        ]

    # Mel spectrogram.
    mel = librosa.feature.melspectrogram(
        y=audio_window,
        sr=SAMPLE_RATE,
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
        n_mels=N_MELS,
        power=2.0,
    )

    # Convert to dB using the same general representation
    # expected by the existing trained models.
    mel_db = librosa.power_to_db(
        mel,
        ref=np.max,
    )

    mel_db = np.nan_to_num(
        mel_db,
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )

    # Models expect 65 time steps.
    if mel_db.shape[1] < MAX_TIME_STEPS:
        mel_db = np.pad(
            mel_db,
            (
                (0, 0),
                (
                    0,
                    MAX_TIME_STEPS
                    - mel_db.shape[1],
                ),
            ),
            mode="constant",
        )

    elif mel_db.shape[1] > MAX_TIME_STEPS:
        mel_db = mel_db[
            :,
            :MAX_TIME_STEPS,
        ]

    features = mel_db[
        :N_MELS,
        :MAX_TIME_STEPS,
    ]

    features = features.astype(
        np.float32,
        copy=False,
    )

    if features.shape != (
        N_MELS,
        MAX_TIME_STEPS,
    ):
        raise ValueError(
            "Generated Mel feature shape is "
            f"{features.shape}, expected "
            f"({N_MELS}, {MAX_TIME_STEPS})."
        )

    return features[
        ...,
        np.newaxis,
    ]


# ---------------------------------------------------------------------------
# Window generation
# ---------------------------------------------------------------------------

def generate_windows(
    audio: np.ndarray,
) -> list[tuple[int, int, np.ndarray]]:
    """
    Split audio into overlapping 3-second windows
    with a 1-second hop.

    Returns:
        [
            (window_index, start_sample, window_audio),
            ...
        ]
    """

    total_samples = len(audio)

    if total_samples <= 0:
        raise ValueError(
            "Audio contains no samples."
        )

    windows = []

    # Short recordings still receive one padded window.
    if total_samples <= WINDOW_SAMPLES:
        padded = np.pad(
            audio,
            (
                0,
                WINDOW_SAMPLES
                - total_samples,
            ),
            mode="constant",
        )

        windows.append(
            (
                0,
                0,
                padded,
            )
        )

        return windows

    start = 0
    index = 0

    while start < total_samples:
        end = start + WINDOW_SAMPLES

        window = audio[
            start:end
        ]

        if len(window) < WINDOW_SAMPLES:
            window = np.pad(
                window,
                (
                    0,
                    WINDOW_SAMPLES
                    - len(window),
                ),
                mode="constant",
            )

        windows.append(
            (
                index,
                start,
                window,
            )
        )

        index += 1
        start += HOP_SAMPLES

        # Do not create a final window that starts
        # after the audio has already ended.
        if start >= total_samples:
            break

    return windows


# ---------------------------------------------------------------------------
# Model prediction
# ---------------------------------------------------------------------------

def extract_scalar_prediction(
    prediction: Any,
    model_name: str,
) -> float:
    """
    Safely extract a scalar model prediction.
    """

    array = np.asarray(
        prediction
    )

    if array.size == 0:
        raise ValueError(
            f"{model_name} returned an empty prediction."
        )

    value = array.reshape(-1)[0]

    return clamp_probability(
        finite_float(
            value,
            f"{model_name} prediction",
        )
    )


def predict_window(
    features: np.ndarray,
) -> tuple[float, float]:
    """
    Run genuine V2 and V4 model inference.

    Returns:
        (v2_real_probability, v4_real_probability)
    """

    if model_v2 is None or model_v4 is None:
        raise RuntimeError(
            "Trained V2/V4 models are not loaded."
        )

    batch = np.expand_dims(
        features,
        axis=0,
    ).astype(
        np.float32,
        copy=False,
    )

    with model_lock:
        raw_v2 = model_v2.predict(
            batch,
            verbose=0,
        )

        raw_v4 = model_v4.predict(
            batch,
            verbose=0,
        )

    v2_real = extract_scalar_prediction(
        raw_v2,
        "V2",
    )

    v4_real = extract_scalar_prediction(
        raw_v4,
        "V4",
    )

    return (
        v2_real,
        v4_real,
    )


# ---------------------------------------------------------------------------
# Full audio analysis
# ---------------------------------------------------------------------------

def analyze_audio(
    audio_bytes: bytes,
) -> dict[str, Any]:
    """
    Analyze the complete recording.

    The overall model score is the average of the
    per-window ensemble deepfake scores.

    Each window also retains:
    - V2 real probability
    - V2 deepfake score
    - V4 real probability
    - V4 deepfake score
    - ensemble deepfake score
    - start/end time
    """

    audio = decode_audio(
        audio_bytes
    )

    duration_seconds = (
        len(audio)
        / SAMPLE_RATE
    )

    if not math.isfinite(
        duration_seconds
    ) or duration_seconds <= 0:
        raise ValueError(
            "Audio duration is invalid."
        )

    windows = generate_windows(
        audio
    )

    window_results = []

    v2_deepfake_scores = []
    v4_deepfake_scores = []
    ensemble_scores = []

    for (
        window_index,
        start_sample,
        window_audio,
    ) in windows:

        features = create_mel_features(
            window_audio
        )

        (
            v2_real_probability,
            v4_real_probability,
        ) = predict_window(
            features
        )

        v2_deepfake_probability = (
            deepfake_score_from_real_probability(
                v2_real_probability
            )
        )

        v4_deepfake_probability = (
            deepfake_score_from_real_probability(
                v4_real_probability
            )
        )

        ensemble_deepfake_probability = (
            (
                v2_deepfake_probability
                + v4_deepfake_probability
            )
            / 2.0
        )

        v2_deepfake_score = score_100(
            v2_deepfake_probability
        )

        v4_deepfake_score = score_100(
            v4_deepfake_probability
        )

        ensemble_score = score_100(
            ensemble_deepfake_probability
        )

        window_start_seconds = (
            start_sample
            / SAMPLE_RATE
        )

        window_end_seconds = min(
            window_start_seconds
            + WINDOW_SECONDS,
            duration_seconds,
        )

        window_result = {
            "window_index": int(
                window_index
            ),

            "start_seconds": round(
                float(
                    window_start_seconds
                ),
                3,
            ),

            "end_seconds": round(
                float(
                    window_end_seconds
                ),
                3,
            ),

            # Model semantics are explicit.
            "v2_real_voice_probability": round(
                float(
                    v2_real_probability
                ),
                6,
            ),

            "v2_deepfake_probability": round(
                float(
                    v2_deepfake_probability
                ),
                6,
            ),

            "v2_score": round(
                float(
                    v2_deepfake_score
                ),
                3,
            ),

            "v4_real_voice_probability": round(
                float(
                    v4_real_probability
                ),
                6,
            ),

            "v4_deepfake_probability": round(
                float(
                    v4_deepfake_probability
                ),
                6,
            ),

            "v4_score": round(
                float(
                    v4_deepfake_score
                ),
                3,
            ),

            "ensemble_deepfake_probability": round(
                float(
                    ensemble_deepfake_probability
                ),
                6,
            ),

            "ensemble_score": round(
                float(
                    ensemble_score
                ),
                3,
            ),

            "model_difference": round(
                abs(
                    v2_deepfake_score
                    - v4_deepfake_score
                ),
                3,
            ),
        }

        window_results.append(
            window_result
        )

        v2_deepfake_scores.append(
            v2_deepfake_score
        )

        v4_deepfake_scores.append(
            v4_deepfake_score
        )

        ensemble_scores.append(
            ensemble_score
        )

    if not window_results:
        raise ValueError(
            "No audio analysis windows were generated."
        )

    # Overall scores are averages across windows.
    v2_score = float(
        np.mean(
            v2_deepfake_scores
        )
    )

    v4_score = float(
        np.mean(
            v4_deepfake_scores
        )
    )

    ensemble_score = float(
        np.mean(
            ensemble_scores
        )
    )

    # Validate all aggregate values.
    v2_score = finite_float(
        v2_score,
        "V2 score",
    )

    v4_score = finite_float(
        v4_score,
        "V4 score",
    )

    ensemble_score = finite_float(
        ensemble_score,
        "ensemble score",
    )

    # Find the highest-risk window.
    peak_window = max(
        window_results,
        key=lambda item: item[
            "ensemble_score"
        ],
    )

    # Model agreement across the whole recording.
    model_difference = abs(
        v2_score - v4_score
    )

    if model_difference <= 10.0:
        agreement_level = "HIGH"

    elif model_difference <= 25.0:
        agreement_level = "MODERATE"

    else:
        agreement_level = "LOW"

    return {
        "success": True,

        "duration_seconds": round(
            float(
                duration_seconds
            ),
            3,
        ),

        "sample_rate": SAMPLE_RATE,

        "window_seconds": WINDOW_SECONDS,

        "hop_seconds": HOP_SECONDS,

        "windows_analyzed": len(
            window_results
        ),

        # Overall deepfake scores.
        "v2_score": round(
            v2_score,
            3,
        ),

        "v4_score": round(
            v4_score,
            3,
        ),

        "ensemble_score": round(
            ensemble_score,
            3,
        ),

        # Explicit probabilities.
        "v2_deepfake_probability": round(
            v2_score / 100.0,
            6,
        ),

        "v2_real_voice_probability": round(
            1.0 - (v2_score / 100.0),
            6,
        ),

        "v4_deepfake_probability": round(
            v4_score / 100.0,
            6,
        ),

        "v4_real_voice_probability": round(
            1.0 - (v4_score / 100.0),
            6,
        ),

        "ensemble_deepfake_probability": round(
            ensemble_score / 100.0,
            6,
        ),

        # Evidence.
        "windows": window_results,

        "peak_window": {
            "window_index": peak_window[
                "window_index"
            ],

            "start_seconds": peak_window[
                "start_seconds"
            ],

            "end_seconds": peak_window[
                "end_seconds"
            ],

            "ensemble_score": peak_window[
                "ensemble_score"
            ],

            "v2_score": peak_window[
                "v2_score"
            ],

            "v4_score": peak_window[
                "v4_score"
            ],
        },

        # Model agreement is only a consistency diagnostic.
        "model_agreement": {
            "difference_points": round(
                model_difference,
                3,
            ),

            "level": agreement_level,

            "diagnostic_only": True,

            "interpretation": (
                "V2 and V4 produced closely aligned "
                "outputs."
                if agreement_level == "HIGH"
                else
                "V2 and V4 show some disagreement."
                if agreement_level == "MODERATE"
                else
                "V2 and V4 show significant disagreement."
            ),
        },

        "model_semantics": (
            "V2 and V4 return REAL-VOICE "
            "probability. Deepfake score is "
            "computed as 1 - real-voice probability."
        ),

        "ensemble_method": (
            "50/50 arithmetic mean of V2 and V4 "
            "deepfake scores for each window, "
            "then averaged across windows."
        ),

        "inference": {
            "genuine_tensorflow_keras": True,
            "model_predict_used": True,
            "models": [
                "audio_deepfake_v2.keras",
                "audio_deepfake_v4.keras",
            ],
        },
    }


# ---------------------------------------------------------------------------
# HTTP response helpers
# ---------------------------------------------------------------------------

def send_json(
    handler: BaseHTTPRequestHandler,
    status_code: int,
    payload: dict[str, Any],
) -> None:

    encoded = json.dumps(
        payload,
        allow_nan=False,
    ).encode(
        "utf-8"
    )

    handler.send_response(
        status_code
    )

    handler.send_header(
        "Content-Type",
        "application/json",
    )

    handler.send_header(
        "Content-Length",
        str(len(encoded)),
    )

    handler.send_header(
        "Access-Control-Allow-Origin",
        "*",
    )

    handler.end_headers()

    handler.wfile.write(
        encoded
    )


def read_json_body(
    handler: BaseHTTPRequestHandler,
) -> dict[str, Any]:

    content_length = int(
        handler.headers.get(
            "Content-Length",
            "0",
        )
    )

    if content_length <= 0:
        raise ValueError(
            "Request body is empty."
        )

    body = handler.rfile.read(
        content_length
    )

    try:
        payload = json.loads(
            body.decode(
                "utf-8"
            )
        )

    except json.JSONDecodeError as error:
        raise ValueError(
            f"Invalid JSON body: {error}"
        )

    if not isinstance(
        payload,
        dict,
    ):
        raise ValueError(
            "Request JSON must be an object."
        )

    return payload


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class MLRequestHandler(
    BaseHTTPRequestHandler
):

    def log_message(
        self,
        format: str,
        *args: Any,
    ) -> None:

        print(
            f"[ML HTTP] {format % args}",
            flush=True,
        )

    def do_OPTIONS(self) -> None:

        self.send_response(
            204
        )

        self.send_header(
            "Access-Control-Allow-Origin",
            "*",
        )

        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS",
        )

        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type",
        )

        self.end_headers()

    def do_GET(self) -> None:

        if self.path == "/health":

            send_json(
                self,
                200,
                {
                    "success": True,

                    "service": "VoiceShield ML Service",

                    "status": "healthy",

                    "trained_models_loaded": (
                        model_v2 is not None
                        and model_v4 is not None
                    ),

                    "models": {
                        "v2": model_v2 is not None,
                        "v4": model_v4 is not None,
                    },

                    "model_semantics": (
                        "Models return REAL-VOICE "
                        "probability. Deepfake score = "
                        "1 - REAL-VOICE probability."
                    ),

                    "model_predict_used": True,

                    "sample_rate": SAMPLE_RATE,

                    "window_seconds": WINDOW_SECONDS,

                    "hop_seconds": HOP_SECONDS,

                    "n_mels": N_MELS,

                    "max_time_steps": MAX_TIME_STEPS,
                },
            )

            return

        send_json(
            self,
            404,
            {
                "success": False,
                "error": "Not found.",
            },
        )

    def do_POST(self) -> None:

        if self.path != "/predict":

            send_json(
                self,
                404,
                {
                    "success": False,
                    "error": "Not found.",
                },
            )

            return

        try:
            payload = read_json_body(
                self
            )

            audio_base64 = payload.get(
                "audio_base64"
            )

            if not isinstance(
                audio_base64,
                str,
            ) or not audio_base64.strip():

                raise ValueError(
                    "audio_base64 is required."
                )

            # Support a possible data-URL prefix.
            if "," in audio_base64:
                prefix, encoded_data = (
                    audio_base64.split(
                        ",",
                        1,
                    )
                )

                if prefix.startswith(
                    "data:"
                ):
                    audio_base64 = (
                        encoded_data
                    )

            try:
                audio_bytes = base64.b64decode(
                    audio_base64,
                    validate=True,
                )

            except Exception as error:
                raise ValueError(
                    f"Invalid base64 audio: {error}"
                )

            result = analyze_audio(
                audio_bytes
            )

            # Final API contract validation.
            required_numeric_fields = [
                "duration_seconds",
                "v2_score",
                "v4_score",
                "ensemble_score",
            ]

            for field in required_numeric_fields:
                finite_float(
                    result.get(field),
                    field,
                )

            send_json(
                self,
                200,
                result,
            )

        except ValueError as error:

            print(
                f"[ML ERROR] {error}",
                flush=True,
            )

            send_json(
                self,
                422,
                {
                    "success": False,

                    "error": str(error),

                    "analysis_available": False,
                },
            )

        except Exception as error:

            print(
                f"[ML ERROR] Unexpected failure: {error}",
                flush=True,
            )

            send_json(
                self,
                500,
                {
                    "success": False,

                    "error": (
                        "VOICE ANALYSIS UNAVAILABLE: "
                        "trained-model inference failed."
                    ),

                    "analysis_available": False,

                    "manual_verification_required": True,
                },
            )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:

    print(
        "[ML] VoiceShield AI ML service starting...",
        flush=True,
    )

    print(
        f"[ML] TensorFlow version: {tf.__version__}",
        flush=True,
    )

    print(
        f"[ML] Keras version: {keras.__version__}",
        flush=True,
    )

    load_models()

    server = HTTPServer(
        (
            HOST,
            PORT,
        ),
        MLRequestHandler,
    )

    print(
        f"[ML] Listening on http://{HOST}:{PORT}",
        flush=True,
    )

    print(
        "[ML] Genuine V2/V4 TensorFlow inference enabled.",
        flush=True,
    )

    print(
        "[ML] Per-window detection evidence enabled.",
        flush=True,
    )

    try:
        server.serve_forever()

    except KeyboardInterrupt:

        print(
            "[ML] Shutting down...",
            flush=True,
        )

    finally:
        server.server_close()


if __name__ == "__main__":
    main()