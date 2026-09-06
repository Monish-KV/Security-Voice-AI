# VoiceShield AI

## Run configuration

The Replit workflow **Start application** runs:

```bash
python app.py
```

It serves the Flask dashboard on port 5000.

## Required model assets

Place the trained model files below in `models/` before attempting inference:

- `models/audio_deepfake_v2.keras`
- `models/audio_deepfake_v4.keras`

The app intentionally does not create substitute models. Without those files,
the dashboard remains available but `/health` reports both models as unloaded
and `/predict` returns a clear model availability error.

## Useful checks

```bash
curl http://localhost:5000/health
python -m py_compile app.py
```