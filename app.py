from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import numpy as np
from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models"
MODEL_PATHS = {
    "v2": MODEL_DIR / "audio_deepfake_v2.keras",
    "v4": MODEL_DIR / "audio_deepfake_v4.keras",
}
ALLOWED_EXTENSIONS = {
    "wav",
    "mp3",
    "m4a",
    "aac",
    "ogg",
    "flac",
    "webm",
    "aiff",
    "aif",
}
SAMPLE_RATE = 16_000
WINDOW_SECONDS = 3
HOP_SECONDS = 1
N_MELS = 128
MAX_TIME_STEPS = 65
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

try:
    import librosa
except ImportError:
    librosa = None

try:
    import tensorflow as tf
except ImportError:
    tf = None


MODELS: dict[str, Any] = {"v2": None, "v4": None}
MODEL_ERRORS: dict[str, str | None] = {"v2": None, "v4": None}


def load_models() -> None:
    """Load both trained models once at application startup."""
    if tf is None:
        message = "TensorFlow/Keras is not installed."
        MODEL_ERRORS.update({"v2": message, "v4": message})
        return

    for version, path in MODEL_PATHS.items():
        if not path.is_file():
            MODEL_ERRORS[version] = f"Model file not found: {path.relative_to(BASE_DIR)}"
            continue
        try:
            # compile=False avoids requiring the training-time optimizer/loss
            # objects while preserving the trained network for predict().
            MODELS[version] = tf.keras.models.load_model(path, compile=False)
        except Exception as exc:  # Keras compatibility/model format errors
            MODEL_ERRORS[version] = f"Could not load {path.name}: {exc}"


load_models()


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def audio_validation_status(audio: np.ndarray) -> tuple[bool, str]:
    if audio.size == 0:
        return False, "No audio samples were decoded."
    if not np.isfinite(audio).all():
        return False, "The decoded audio contains invalid numeric values."
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio), dtype=np.float64)))
    if peak < 1e-5 or rms < 1e-5:
        return False, "The recording appears to be silent."
    return True, "Usable audio detected."


def make_windows(audio: np.ndarray) -> np.ndarray:
    """Create 3-second audio windows with a 1-second hop, padding the tail."""
    window_size = WINDOW_SECONDS * SAMPLE_RATE
    hop_size = HOP_SECONDS * SAMPLE_RATE
    if len(audio) <= window_size:
        starts = [0]
    else:
        starts = list(range(0, len(audio) - window_size + 1, hop_size))
        if starts[-1] + window_size < len(audio):
            starts.append(len(audio) - window_size)

    windows = []
    for start in starts:
        window = audio[start : start + window_size]
        if len(window) < window_size:
            window = np.pad(window, (0, window_size - len(window)))
        windows.append(window)
    return np.asarray(windows, dtype=np.float32)


def extract_features(audio: np.ndarray) -> np.ndarray:
    if librosa is None:
        raise RuntimeError("Librosa is not installed.")

    features = []
    for window in make_windows(audio):
        mel = librosa.feature.melspectrogram(
            y=window,
            sr=SAMPLE_RATE,
            n_fft=1024,
            hop_length=512,
            n_mels=N_MELS,
            power=2.0,
        )
        mel_db = librosa.power_to_db(mel, ref=np.max)
        # Models expect time-major mel features with a maximum of 65 frames.
        time_major = mel_db.T
        if time_major.shape[0] > MAX_TIME_STEPS:
            time_major = time_major[:MAX_TIME_STEPS]
        elif time_major.shape[0] < MAX_TIME_STEPS:
            time_major = np.pad(
                time_major,
                ((0, MAX_TIME_STEPS - time_major.shape[0]), (0, 0)),
                mode="constant",
            )
        features.append(time_major.astype(np.float32))
    return np.asarray(features, dtype=np.float32)


def model_input(features: np.ndarray, model: Any) -> np.ndarray:
    """Adapt the fixed feature tensor to the model's declared input rank."""
    shape = model.input_shape
    if isinstance(shape, list):
        if len(shape) != 1:
            raise RuntimeError("Only single-input audio models are supported.")
        shape = shape[0]
    rank = len(shape)
    if rank == 4:
        return features[..., np.newaxis]
    if rank == 3:
        return features
    if rank == 2:
        expected = shape[-1]
        actual = MAX_TIME_STEPS * N_MELS
        if expected not in (None, actual):
            raise RuntimeError(f"Model expects {expected} features, not {actual}.")
        return features.reshape(features.shape[0], -1)
    raise RuntimeError(f"Unsupported model input rank: {rank}.")


def extract_probability(prediction: Any, version: str) -> float:
    values = np.asarray(prediction, dtype=np.float32).squeeze()
    if values.ndim == 0:
        value = float(values)
    elif values.ndim == 1 and values.size == 1:
        value = float(values[0])
    elif values.ndim == 1 and values.size == 2:
        value = float(values[1])
    else:
        raise RuntimeError(
            f"{version.upper()} returned an unsupported prediction shape: {values.shape}."
        )
    if not np.isfinite(value) or not 0.0 <= value <= 1.0:
        raise RuntimeError(
            f"{version.upper()} returned a value outside the expected probability range."
        )
    return value


def predict_for_model(version: str, features: np.ndarray) -> float:
    model = MODELS.get(version)
    if model is None:
        raise RuntimeError(MODEL_ERRORS[version] or f"{version.upper()} model is unavailable.")
    batch = model_input(features, model)
    predictions = model.predict(batch, verbose=0)
    per_window = [extract_probability(row, version) for row in predictions]
    if not per_window:
        raise RuntimeError(f"{version.upper()} returned no predictions.")
    return float(np.mean(per_window))


def risk_level(score: float) -> str:
    if score < 0.33:
        return "LOW"
    if score < 0.66:
        return "MEDIUM"
    return "HIGH"


@app.get("/")
def index():
    return render_template(
        "index.html",
        tensorflow_available=tf is not None,
        models_loaded=all(model is not None for model in MODELS.values()),
    )


@app.get("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "tensorflow_available": tf is not None,
            "keras_available": tf is not None,
            "models": {
                "v2": {
                    "loaded": MODELS["v2"] is not None,
                    "path": str(MODEL_PATHS["v2"].relative_to(BASE_DIR)),
                    "error": MODEL_ERRORS["v2"],
                },
                "v4": {
                    "loaded": MODELS["v4"] is not None,
                    "path": str(MODEL_PATHS["v4"].relative_to(BASE_DIR)),
                    "error": MODEL_ERRORS["v4"],
                },
            },
        }
    )


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "The audio file is larger than the 50 MB limit."}), 413


@app.post("/predict")
def predict():
    started = time.perf_counter()
    uploaded = request.files.get("audio")
    if uploaded is None or not uploaded.filename:
        return jsonify({"error": "Attach an audio file using the 'audio' field."}), 400

    filename = secure_filename(uploaded.filename)
    if not filename or not allowed_file(filename):
        return jsonify(
            {
                "error": "Unsupported audio format. Use WAV, MP3, M4A, OGG, FLAC, or another supported format."
            }
        ), 400

    temp_path = None
    try:
        # Librosa delegates compressed formats to FFmpeg/audioread when needed.
        import tempfile

        suffix = Path(filename).suffix.lower()
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_path = Path(temp_file.name)
            uploaded.save(temp_path)
        if librosa is None:
            raise RuntimeError("Librosa is not installed.")
        audio, _ = librosa.load(temp_path, sr=SAMPLE_RATE, mono=True)
        valid, validation_message = audio_validation_status(audio)
        if not valid:
            return jsonify(
                {
                    "error": validation_message,
                    "filename": filename,
                    "audio_validation": {"valid": False, "message": validation_message},
                }
            ), 422

        features = extract_features(audio)
        v2_score = predict_for_model("v2", features)
        v4_score = predict_for_model("v4", features)
        ensemble = (v2_score + v4_score) / 2.0
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        return jsonify(
            {
                "filename": filename,
                "duration_seconds": round(float(len(audio) / SAMPLE_RATE), 2),
                "audio_validation": {"valid": True, "message": validation_message},
                "v2_prediction": round(v2_score, 6),
                "v4_prediction": round(v4_score, 6),
                "ensemble_score": round(ensemble, 6),
                "risk_level": risk_level(ensemble),
                "processing_time_ms": elapsed_ms,
                "model_statement": "Prediction generated by trained V2 + V4 TensorFlow/Keras models.",
            }
        )
    except Exception as exc:
        return jsonify(
            {
                "error": str(exc),
                "filename": filename,
                "processing_time_ms": round((time.perf_counter() - started) * 1000, 2),
            }
        ), 500
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)