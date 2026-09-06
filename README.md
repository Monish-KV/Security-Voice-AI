# VoiceShield AI

VoiceShield AI is a Flask MVP for analyzing uploaded voice recordings with two
trained TensorFlow/Keras audio deepfake detection models.

## What it does

- Accepts WAV, MP3, M4A, OGG, FLAC, and other formats supported by Librosa/FFmpeg.
- Converts input to 16 kHz mono audio.
- Extracts 128-bin mel spectrogram windows using 3-second windows and a
  1-second hop, capped at 65 time steps.
- Runs the actual `model.predict()` method on both:
  - `models/audio_deepfake_v2.keras`
  - `models/audio_deepfake_v4.keras`
- Shows each model score, a 50/50 ensemble score, an application-level risk
  classification, validation status, duration, and processing time.

This prototype analyzes uploaded recordings only. It does not claim real-time
call detection or model accuracy.

## Models

Place the trained `.keras` files in the `models/` directory. The application
does not create substitute models and does not generate predictions when either
model is missing. The dashboard and `/health` endpoint report missing models
explicitly.

The implementation expects each model to return either:

- one probability value between 0 and 1, or
- two class probabilities where index 1 is the deepfake probability.

Unexpected output or inference errors are returned as errors rather than being
converted into a fabricated result.

## Run locally

```bash
pip install -r requirements.txt
python app.py
```

Then open `http://localhost:5000`.

## API

### `GET /health`

Returns application status, TensorFlow availability, and whether the V2 and V4
models loaded successfully.

### `POST /predict`

Send an audio file as multipart form data under the `audio` field:

```bash
curl -F "audio=@recording.wav" http://localhost:5000/predict
```

The API returns the filename, duration, audio validation status, separate V2
and V4 predictions, the ensemble score, risk level, and processing time.

## Development notes

The application is intentionally small and has no authentication, database,
payments, speaker recognition, blockchain, or audit system.