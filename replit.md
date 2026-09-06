# VoiceShield AI

## Run configuration

The Replit workflow **Start application** runs:

```bash
python app.py
```

It serves the Flask dashboard on port 5000.

## Model assets

The imported trained model files are already present:

- `models/audio_deepfake_v2.keras`
- `models/audio_deepfake_v4.keras`

The app intentionally does not create substitute models. If either file is
removed or cannot load, `/health` reports the exact model error and `/predict`
returns a clear model availability error.

The models accept `(batch, 128, 65, 1)` mel features and the original model
output is real-voice probability. The app uses its complement as the
deepfake probability, calls `model.predict()`, and labels contextual scoring
separately from model output.

## Product boundaries

The live page is a browser microphone demonstration that sends short chunks
through the same `/predict` endpoint. It is labelled near-real-time prototype
and does not intercept calls or connect to external banking/telecom systems.
Speaker verification is an extension point only because no genuine
speaker-verification model is available.

Local JSON/JSONL state is stored in `data/` for incidents, settings, and the
tamper-evident audit trail. Raw audio is deleted after each analysis.

## Useful checks

```bash
curl http://localhost:5000/health
python -m py_compile app.py
python -m py_compile storage.py
```