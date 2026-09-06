"""Small local persistence layer for the prototype.

JSONL/JSON keeps the project dependency-free and makes it straightforward to
replace this module with a production database adapter later.
"""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
AUDIT_FILE = DATA_DIR / "audit_events.jsonl"
INCIDENTS_FILE = DATA_DIR / "incidents.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
LOCK = threading.RLock()

DEFAULT_SETTINGS: dict[str, Any] = {
    "medium_threshold": 40.0,
    "high_threshold": 75.0,
    "unknown_caller_policy": "VERIFY",
    "high_value_policy": "ESCALATE",
    "verification_required": True,
    "escalation_threshold": 75.0,
    "audio_retention": "delete_after_analysis",
    "audit_retention": "local",
    "anonymized_logging": True,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def initialize() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    if not INCIDENTS_FILE.exists():
        INCIDENTS_FILE.write_text("[]", encoding="utf-8")
    if not SETTINGS_FILE.exists():
        SETTINGS_FILE.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")
    AUDIT_FILE.touch(exist_ok=True)


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def load_settings() -> dict[str, Any]:
    initialize()
    settings = dict(DEFAULT_SETTINGS)
    settings.update(_read_json(SETTINGS_FILE, {}))
    return settings


def save_settings(incoming: dict[str, Any]) -> dict[str, Any]:
    initialize()
    settings = load_settings()
    settings.update({key: incoming[key] for key in DEFAULT_SETTINGS if key in incoming})
    settings["medium_threshold"] = max(0.0, min(99.0, float(settings["medium_threshold"])))
    settings["high_threshold"] = max(
        settings["medium_threshold"] + 1.0,
        min(100.0, float(settings["high_threshold"])),
    )
    settings["escalation_threshold"] = max(
        settings["medium_threshold"],
        min(100.0, float(settings["escalation_threshold"])),
    )
    for key in ("verification_required", "anonymized_logging"):
        settings[key] = bool(settings[key])
    with LOCK:
        SETTINGS_FILE.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    append_audit("SETTINGS_CHANGED", {"changed_keys": sorted(incoming.keys())})
    return settings


def read_audit(limit: int = 100) -> list[dict[str, Any]]:
    initialize()
    events: list[dict[str, Any]] = []
    with LOCK:
        for line in AUDIT_FILE.read_text(encoding="utf-8").splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return list(reversed(events[-limit:]))


def append_audit(event_type: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    initialize()
    latest = read_audit(limit=1)
    previous_hash = latest[0].get("event_hash", "GENESIS") if latest else "GENESIS"
    event = {
        "event_id": str(uuid.uuid4()),
        "timestamp": now_iso(),
        "event_type": event_type,
        "details": details or {},
        "previous_hash": previous_hash,
    }
    payload = json.dumps(event, sort_keys=True, separators=(",", ":")).encode()
    event["event_hash"] = hashlib.sha256(payload).hexdigest()
    with LOCK:
        with AUDIT_FILE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, sort_keys=True) + "\n")
    return event


def verify_audit() -> dict[str, Any]:
    initialize()
    raw_events: list[dict[str, Any]] = []
    with LOCK:
        for line in AUDIT_FILE.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    raw_events.append(json.loads(line))
                except json.JSONDecodeError:
                    return {"valid": False, "checked": 0, "message": "Malformed audit record."}

    previous_hash = "GENESIS"
    for index, event in enumerate(raw_events):
        if event.get("previous_hash") != previous_hash:
            return {
                "valid": False,
                "checked": index,
                "message": "Audit hash chain mismatch detected.",
            }
        stored_hash = event.get("event_hash")
        unsigned = dict(event)
        unsigned.pop("event_hash", None)
        expected_hash = hashlib.sha256(
            json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        if stored_hash != expected_hash:
            return {
                "valid": False,
                "checked": index,
                "message": "Audit event hash mismatch detected.",
            }
        previous_hash = stored_hash
    return {
        "valid": True,
        "checked": len(raw_events),
        "message": "Tamper-evident audit chain verified.",
    }


def read_incidents() -> list[dict[str, Any]]:
    initialize()
    incidents = _read_json(INCIDENTS_FILE, [])
    return list(reversed(incidents))


def create_incident(payload: dict[str, Any]) -> dict[str, Any]:
    initialize()
    incident = {
        "incident_id": f"INC-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}",
        "timestamp": now_iso(),
        "risk_level": payload.get("risk_level", "HIGH"),
        "voice_score": payload.get("voice_score"),
        "security_risk": payload.get("security_risk"),
        "recommended_action": payload.get("recommended_action", "VERIFY"),
        "reason": payload.get("reason", "High-risk voice analysis"),
        "analysis_id": payload.get("analysis_id"),
        "status": "OPEN",
    }
    with LOCK:
        incidents = _read_json(INCIDENTS_FILE, [])
        incidents.append(incident)
        INCIDENTS_FILE.write_text(json.dumps(incidents, indent=2), encoding="utf-8")
    append_audit("INCIDENT_CREATED", {"incident_id": incident["incident_id"], "risk_level": incident["risk_level"]})
    return incident


def update_incident(incident_id: str, status: str) -> dict[str, Any] | None:
    if status not in {"OPEN", "INVESTIGATING", "RESOLVED"}:
        raise ValueError("Status must be OPEN, INVESTIGATING, or RESOLVED.")
    with LOCK:
        incidents = _read_json(INCIDENTS_FILE, [])
        found = next((item for item in incidents if item["incident_id"] == incident_id), None)
        if found is None:
            return None
        found["status"] = status
        INCIDENTS_FILE.write_text(json.dumps(incidents, indent=2), encoding="utf-8")
    append_audit("INCIDENT_STATUS_CHANGED", {"incident_id": incident_id, "status": status})
    return found
