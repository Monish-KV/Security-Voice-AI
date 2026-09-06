from __future__ import annotations

import json
import logging
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

import storage

BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models"
MODEL_PATHS = {
    "v2": MODEL_DIR / "audio_deepfake_v2.keras",
    "v4": MODEL_DIR / "audio_deepfake_v4.keras",
}
ALLOWED_EXTENSIONS = {"wav", "mp3", "m4a", "aac", "ogg", "flac", "webm", "aiff", "aif"}
SAMPLE_RATE = 16_000
WINDOW_SECONDS = 3
HOP_SECONDS = 1
N_MELS = 128
MAX_TIME_STEPS = 65
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
app.config["JSON_SORT_KEYS"] = False
app.logger.setLevel(logging.INFO)

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
storage.initialize()


def load_models() -> None:
    if tf is None:
        message = "TensorFlow/Keras is not installed."
        MODEL_ERRORS.update({"v2": message, "v4": message})
        return
    for version, path in MODEL_PATHS.items():
        if not path.is_file():
            MODEL_ERRORS[version] = f"Model file not found: {path.relative_to(BASE_DIR)}"
            continue
        try:
            MODELS[version] = tf.keras.models.load_model(path, compile=False)
            app.logger.info("Loaded real %s model from %s", version.upper(), path)
        except Exception as exc:
            MODEL_ERRORS[version] = f"Could not load {path.name}: {exc}"
            app.logger.exception("Could not load %s model", version.upper())


load_models()


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def audio_validation_status(audio: np.ndarray) -> tuple[bool, dict[str, Any]]:
    if audio.size == 0 or not np.isfinite(audio).all():
        return False, {"message": "No usable audio was decoded.", "active_speech_seconds": 0}
    duration = len(audio) / SAMPLE_RATE
    if duration < 0.75:
        return False, {"message": "Recording is too short. Capture at least 0.75 seconds.", "active_speech_seconds": 0}
    if librosa is None:
        return False, {"message": "Librosa is unavailable for speech validation.", "active_speech_seconds": 0}
    rms = librosa.feature.rms(y=audio, frame_length=1024, hop_length=256)[0]
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    max_rms = float(np.max(rms)) if len(rms) else 0.0
    if peak < 0.003 or max_rms < 0.003:
        return False, {"message": "No audible speech was detected.", "active_speech_seconds": 0}
    active_frames = int(np.sum(rms >= max(0.006, max_rms * 0.12)))
    active_seconds = active_frames * 256 / SAMPLE_RATE
    if active_seconds < 0.45:
        return False, {"message": "Not enough audible speech was detected.", "active_speech_seconds": round(active_seconds, 2)}
    return True, {
        "message": "Usable speech/audio detected.",
        "active_speech_seconds": round(active_seconds, 2),
        "duration_seconds": round(duration, 2),
    }


def split_segments(audio: np.ndarray) -> list[tuple[int, np.ndarray]]:
    window_samples = SAMPLE_RATE * WINDOW_SECONDS
    hop_samples = SAMPLE_RATE * HOP_SECONDS
    if len(audio) <= window_samples:
        return [(0, audio)]
    segments = []
    start = 0
    while start < len(audio):
        segment = audio[start : start + window_samples]
        if len(segment) >= SAMPLE_RATE:
            segments.append((start, segment))
        start += hop_samples
    return segments or [(0, audio)]


def audio_to_features(segment: np.ndarray) -> np.ndarray:
    if librosa is None:
        raise RuntimeError("Librosa is not installed.")
    target_length = SAMPLE_RATE * WINDOW_SECONDS
    if len(segment) < target_length:
        segment = np.pad(segment, (0, target_length - len(segment)))
    else:
        segment = segment[:target_length]
    mel = librosa.feature.melspectrogram(
        y=np.clip(segment, -1.0, 1.0),
        sr=SAMPLE_RATE,
        n_mels=N_MELS,
    )
    mel_db = librosa.power_to_db(mel, ref=np.max)
    if mel_db.shape[1] < MAX_TIME_STEPS:
        mel_db = np.pad(mel_db, ((0, 0), (0, MAX_TIME_STEPS - mel_db.shape[1])), mode="constant")
    else:
        mel_db = mel_db[:, :MAX_TIME_STEPS]
    return mel_db[np.newaxis, ..., np.newaxis].astype(np.float32)


def model_predict(version: str, batch: np.ndarray) -> dict[str, float]:
    model = MODELS.get(version)
    if model is None:
        raise RuntimeError(MODEL_ERRORS[version] or f"{version.upper()} model is unavailable.")
    expected = tuple(model.input_shape)
    if expected[1:] != (N_MELS, MAX_TIME_STEPS, 1):
        raise RuntimeError(f"{version.upper()} input shape {expected} does not match (None, 128, 65, 1).")
    prediction = np.asarray(model.predict(batch, verbose=0)).squeeze()
    if prediction.ndim == 0:
        real_probability = float(prediction)
    elif prediction.ndim == 1 and prediction.size == 1:
        real_probability = float(prediction[0])
    else:
        raise RuntimeError(f"{version.upper()} returned unsupported output shape {prediction.shape}.")
    if not np.isfinite(real_probability) or not 0 <= real_probability <= 1:
        raise RuntimeError(f"{version.upper()} returned an invalid probability.")
    # The supplied models are trained to emit real-voice probability. The
    # security score is the complementary deepfake probability.
    deepfake_probability = 1.0 - real_probability
    if not np.isfinite(deepfake_probability) or not 0 <= deepfake_probability <= 1:
        raise RuntimeError(f"{version.upper()} produced an invalid deepfake probability.")
    return {
        "real_voice_probability": real_probability,
        "deepfake_probability": deepfake_probability,
    }


def require_finite_number(value: Any, field_name: str, *, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Prediction response field '{field_name}' is not numeric.") from exc
    if not np.isfinite(number):
        raise RuntimeError(f"Prediction response field '{field_name}' is not finite.")
    if minimum is not None and number < minimum:
        raise RuntimeError(f"Prediction response field '{field_name}' is below {minimum}.")
    if maximum is not None and number > maximum:
        raise RuntimeError(f"Prediction response field '{field_name}' is above {maximum}.")
    return number


def validate_prediction_result(result: dict[str, Any]) -> None:
    probability_fields = (
        "v2_real_voice_probability",
        "v2_deepfake_probability",
        "v4_real_voice_probability",
        "v4_deepfake_probability",
    )
    percentage_fields = ("v2_score", "v4_score", "ensemble_score", "model_score")
    for field_name in probability_fields:
        require_finite_number(result.get(field_name), field_name, minimum=0, maximum=1)
    for field_name in percentage_fields:
        require_finite_number(result.get(field_name), field_name, minimum=0, maximum=100)
    require_finite_number(result.get("duration_seconds"), "duration_seconds", minimum=0)
    require_finite_number(result.get("processing_time_ms"), "processing_time_ms", minimum=0)
    security = result.get("security")
    if not isinstance(security, dict):
        raise RuntimeError("Prediction response is missing the security result.")
    require_finite_number(security.get("security_risk_score"), "security.security_risk_score", minimum=0, maximum=100)


def risk_level(score: float, settings: dict[str, Any]) -> str:
    if score >= float(settings["high_threshold"]):
        return "HIGH"
    if score >= float(settings["medium_threshold"]):
        return "MEDIUM"
    return "LOW"


def context_from_request(source: dict[str, Any]) -> dict[str, Any]:
    booleans = ("unknown_caller", "first_time_caller", "sensitive_request", "high_value_transaction", "previous_high_risk")
    context = {key: str(source.get(key, "false")).lower() in {"true", "1", "yes", "on"} for key in booleans}
    context["caller_type"] = source.get("caller_type", "KNOWN")
    context["requested_action"] = source.get("requested_action", "OTHER")
    context["social_signals"] = source.get("social_signals", [])
    if isinstance(context["social_signals"], str):
        try:
            context["social_signals"] = json.loads(context["social_signals"])
        except json.JSONDecodeError:
            context["social_signals"] = [context["social_signals"]]
    return context


def assess_security(model_score: float, context: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    adjustment = 0.0
    reasons: list[str] = []
    if context["unknown_caller"] or context["caller_type"] == "UNKNOWN":
        adjustment += 8
        reasons.append("unknown caller")
    if context["first_time_caller"]:
        adjustment += 5
        reasons.append("first-time caller")
    if context["sensitive_request"]:
        adjustment += 12
        reasons.append("sensitive request")
    if context["high_value_transaction"]:
        adjustment += 15
        reasons.append("high-value transaction")
    if context["previous_high_risk"]:
        adjustment += 10
        reasons.append("previous high-risk interaction")
    signal_weights = {
        "urgent_payment": 12,
        "secrecy_request": 10,
        "credential_request": 14,
        "authority_claim": 8,
        "bypass_verification": 14,
        "change_payment_details": 15,
    }
    social_score = 0.0
    for signal in context["social_signals"]:
        if signal in signal_weights:
            social_score += signal_weights[signal]
            reasons.append(signal.replace("_", " "))
    social_score = min(100.0, social_score)
    security_score = min(100.0, model_score + adjustment + social_score)
    level = risk_level(security_score, settings)
    if security_score >= float(settings["escalation_threshold"]):
        action = "BLOCK"
        recommendation = "Pause the request. Require independent callback and approved verification before proceeding."
    elif level == "HIGH":
        action = "ESCALATE"
        recommendation = "Escalate to a security analyst and verify through a trusted channel."
    elif level == "MEDIUM":
        action = "VERIFY"
        recommendation = "Monitor the interaction and complete an independent identity check."
    elif context["unknown_caller"] or context["first_time_caller"]:
        action = "MONITOR"
        recommendation = "Continue only with normal controls and heightened monitoring."
    else:
        action = "ALLOW"
        recommendation = "No strong synthetic signal detected; continue normal verification."
    return {
        "model_score": round(model_score, 2),
        "context_adjustment": round(adjustment, 2),
        "social_engineering_score": round(social_score, 2),
        "security_risk_score": round(security_score, 2),
        "risk_level": level,
        "recommended_action": action,
        "recommendation": recommendation,
        "reasons": reasons or ["no additional contextual risk signals"],
        "is_model_accuracy": False,
    }


def analyze_audio(audio: np.ndarray, context: dict[str, Any]) -> dict[str, Any]:
    settings = storage.load_settings()
    timeline = []
    v2_real_probabilities, v2_deepfake_probabilities = [], []
    v4_real_probabilities, v4_deepfake_probabilities = [], []
    v2_scores, v4_scores, ensemble_scores = [], [], []
    for start_sample, segment in split_segments(audio):
        batch = audio_to_features(segment)
        v2_prediction = model_predict("v2", batch)
        v4_prediction = model_predict("v4", batch)
        v2_real_probabilities.append(v2_prediction["real_voice_probability"])
        v2_deepfake_probabilities.append(v2_prediction["deepfake_probability"])
        v4_real_probabilities.append(v4_prediction["real_voice_probability"])
        v4_deepfake_probabilities.append(v4_prediction["deepfake_probability"])
        v2_score = v2_prediction["deepfake_probability"] * 100
        v4_score = v4_prediction["deepfake_probability"] * 100
        ensemble = (v2_score + v4_score) / 2
        v2_scores.append(v2_score)
        v4_scores.append(v4_score)
        ensemble_scores.append(ensemble)
        start = start_sample / SAMPLE_RATE
        timeline.append({
            "start_seconds": round(start, 2),
            "end_seconds": round(min(start + WINDOW_SECONDS, len(audio) / SAMPLE_RATE), 2),
            "v2_score": round(v2_score, 2),
            "v4_score": round(v4_score, 2),
            "ensemble_score": round(ensemble, 2),
            "status": "HIGH" if ensemble >= float(settings["high_threshold"]) else "ELEVATED" if ensemble >= float(settings["medium_threshold"]) else "CLEAR",
        })
    model_score = float(np.mean(ensemble_scores))
    security = assess_security(model_score, context, settings)
    return {
        "analysis_id": f"AN-{uuid.uuid4().hex[:10].upper()}",
        "duration_seconds": round(len(audio) / SAMPLE_RATE, 2),
        "v2_real_voice_probability": round(float(np.mean(v2_real_probabilities)), 6),
        "v2_deepfake_probability": round(float(np.mean(v2_deepfake_probabilities)), 6),
        "v4_real_voice_probability": round(float(np.mean(v4_real_probabilities)), 6),
        "v4_deepfake_probability": round(float(np.mean(v4_deepfake_probabilities)), 6),
        "v2_score": round(float(np.mean(v2_scores)), 2),
        "v4_score": round(float(np.mean(v4_scores)), 2),
        "ensemble_score": round(model_score, 2),
        "model_score": round(model_score, 2),
        "security": security,
        "timeline": timeline,
        "context": context,
        "speaker_verification": {
            "available": False,
            "status": "Extension point only",
            "message": "No genuine speaker-verification model is installed. No similarity score was fabricated.",
        },
        "model_statement": "Real output from trained V2 + V4 TensorFlow/Keras models via model.predict().",
        "privacy": {"raw_audio_retained": False, "raw_audio_deleted_after_analysis": True},
        "settings_snapshot": {
            "medium_threshold": settings["medium_threshold"],
            "high_threshold": settings["high_threshold"],
        },
    }


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify({
        "status": "online",
        "tensorflow_available": tf is not None,
        "keras_available": tf is not None,
        "models": {
            version: {
                "loaded": MODELS[version] is not None,
                "path": str(path.relative_to(BASE_DIR)),
                "error": MODEL_ERRORS[version],
                "input_shape": str(getattr(MODELS[version], "input_shape", "")) if MODELS[version] is not None else None,
            }
            for version, path in MODEL_PATHS.items()
        },
        "audio_pipeline": {"sample_rate": SAMPLE_RATE, "window_seconds": WINDOW_SECONDS, "hop_seconds": HOP_SECONDS, "mel_bins": N_MELS, "max_time_steps": MAX_TIME_STEPS},
        "speaker_verification": {"available": False, "status": "extension_point"},
    })


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"success": False, "error": "The audio file is larger than the 100 MB limit."}), 413


@app.post("/predict")
def predict():
    started = time.perf_counter()
    uploaded = request.files.get("audio")
    if uploaded is None or not uploaded.filename:
        return jsonify({"success": False, "error": "Attach an audio file using the 'audio' field."}), 400
    filename = secure_filename(uploaded.filename)
    if not filename or not allowed_file(filename):
        return jsonify({"success": False, "error": "Unsupported audio format. Use WAV, MP3, M4A, OGG, or FLAC."}), 400
    if not all(MODELS.values()):
        missing = [version.upper() for version, model in MODELS.items() if model is None]
        return jsonify({"success": False, "error": f"Real model inference unavailable. Missing/unloaded: {', '.join(missing)}.", "health": "/health"}), 503
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix.lower(), delete=False) as temp_file:
            temp_path = Path(temp_file.name)
            uploaded.save(temp_path)
        audio, _ = librosa.load(temp_path, sr=SAMPLE_RATE, mono=True)
        valid, validation = audio_validation_status(audio)
        if not valid:
            return jsonify({"success": False, "error": validation["message"], "audio_validation": validation}), 422
        context = context_from_request(request.form)
        result = analyze_audio(audio, context)
        result["filename"] = filename
        result["audio_validation"] = {"valid": True, **validation}
        result["processing_time_ms"] = round((time.perf_counter() - started) * 1000, 2)
        validate_prediction_result(result)
        audit = storage.append_audit("ANALYSIS_PERFORMED", {
            "analysis_id": result["analysis_id"],
            "filename": filename if not storage.load_settings()["anonymized_logging"] else "redacted",
            "risk_level": result["security"]["risk_level"],
            "security_risk_score": result["security"]["security_risk_score"],
            "model_score": result["model_score"],
            "source_type": request.form.get("source_type", "uploaded_recording"),
        })
        if result["security"]["risk_level"] == "HIGH":
            storage.append_audit("HIGH_RISK_DETECTION", {"analysis_id": result["analysis_id"], "risk_score": result["security"]["security_risk_score"]})
        result["audit_event_id"] = audit["event_id"]
        result["audit_integrity"] = "CHAINED"
        return jsonify({"success": True, "result": result})
    except Exception as exc:
        app.logger.exception("Prediction failed")
        return jsonify({"success": False, "error": str(exc), "processing_time_ms": round((time.perf_counter() - started) * 1000, 2)}), 500
    finally:
        if temp_path:
            temp_path.unlink(missing_ok=True)


@app.get("/api/events")
def api_events():
    return jsonify({"success": True, "events": storage.read_audit()})


@app.get("/api/incidents")
def api_incidents():
    return jsonify({"success": True, "incidents": storage.read_incidents()})


@app.post("/api/incidents")
def api_create_incident():
    payload = request.get_json(silent=True) or {}
    if not payload.get("analysis_id") and not payload.get("reason"):
        return jsonify({"success": False, "error": "An analysis ID or incident reason is required."}), 400
    return jsonify({"success": True, "incident": storage.create_incident(payload)}), 201


@app.patch("/api/incidents/<incident_id>")
def api_update_incident(incident_id: str):
    payload = request.get_json(silent=True) or {}
    try:
        incident = storage.update_incident(incident_id, str(payload.get("status", "")).upper())
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    if incident is None:
        return jsonify({"success": False, "error": "Incident not found."}), 404
    return jsonify({"success": True, "incident": incident})


@app.get("/api/settings")
def api_get_settings():
    return jsonify({"success": True, "settings": storage.load_settings()})


@app.post("/api/settings")
def api_save_settings():
    try:
        return jsonify({"success": True, "settings": storage.save_settings(request.get_json(silent=True) or {})})
    except (TypeError, ValueError) as exc:
        return jsonify({"success": False, "error": f"Invalid setting: {exc}"}), 400


@app.get("/api/audit")
def api_audit():
    return jsonify({"success": True, "events": storage.read_audit()})


@app.get("/api/audit/verify")
def api_audit_verify():
    return jsonify(storage.verify_audit())


@app.get("/api/privacy")
def api_privacy():
    verification = storage.verify_audit()
    return jsonify({
        "success": True,
        "raw_audio_retained": False,
        "temporary_files_deleted": True,
        "retention_setting": storage.load_settings()["audio_retention"],
        "audit_chain_valid": verification["valid"],
        "audit_event_count": verification["checked"],
        "speaker_verification_available": False,
    })


@app.post("/api/security-action")
def api_security_action():
    payload = request.get_json(silent=True) or {}
    event = storage.append_audit("SECURITY_ACTION", {
        "action": payload.get("action", "VERIFY"),
        "analysis_id": payload.get("analysis_id"),
        "risk_level": payload.get("risk_level"),
    })
    return jsonify({"success": True, "event": event})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)