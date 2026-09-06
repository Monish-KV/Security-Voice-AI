# VoiceShield AI

VoiceShield AI is a Flask cybersecurity operations prototype for analyzing
uploaded voice recordings with two trained TensorFlow/Keras audio deepfake
detection models, adding analyst context, and tracking security response.

## What it does

- Accepts WAV, MP3, M4A, OGG, FLAC, and other formats supported by Librosa/FFmpeg.
- Converts input to 16 kHz mono audio.
- Extracts 128-bin mel spectrogram windows using 3-second windows and a
  1-second hop, capped at 65 time steps.
- Runs the actual `model.predict()` method on both:
  - `models/audio_deepfake_v2.keras`
  - `models/audio_deepfake_v4.keras`
- Shows the distinct model score and contextual security risk score, with an
  explainable recommended security action.
- Provides dashboard, voice analysis, near-real-time microphone prototype,
  incident center, audit trail, privacy center, settings, and printable
  analysis report views.
- Persists incidents, settings, and tamper-evident audit records locally in
  `data/`. This module can later be replaced with a production database.

The live view is explicitly a near-real-time browser microphone prototype. It
does not intercept telecom calls, connect to banking systems, or claim model
accuracy.

## Models

The exact trained files are included in this project under `models/`. They were
imported from the original VoiceShield repository:

- `models/audio_deepfake_v2.keras`
- `models/audio_deepfake_v4.keras`

Both load at startup with `tf.keras.models.load_model(..., compile=False)`.
They accept `(batch, 128, 65, 1)` and emit the original project's real-voice
probability. VoiceShield reports the complementary deepfake probability and
uses `model.predict()` for every analysis. It does not create substitute
models, synthetic predictions, or filename/hash scores.

Unexpected model shape/output, decoding, validation, and inference errors are
returned as errors rather than being converted into fabricated results.

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

The API returns audio metadata, real V2/V4 predictions, the 50/50 model score,
contextual signals, security risk, recommended action, timeline, audit ID, and
privacy status. Optional multipart context fields include `caller_type`,
`first_time_caller`, `sensitive_request`, `high_value_transaction`,
`previous_high_risk`, `requested_action`, and JSON `social_signals`.

### Local operations API

- `GET /api/events` and `GET /api/audit` — analysis/security event history
- `GET /api/incidents`, `POST /api/incidents`,
  `PATCH /api/incidents/<incident_id>` — local incident management
- `GET /api/settings`, `POST /api/settings` — contextual policy settings
- `GET /api/audit/verify` — verify the audit hash chain
- `GET /api/privacy` — privacy and retention status
- `POST /api/security-action` — record an analyst action

## Development notes

## Truthful boundaries

- Model score is real ML output. Security risk and social-engineering signals
  are explicit contextual logic, not ML accuracy.
- Speaker verification is a clearly labelled extension point. No similarity
  score is produced because a genuine speaker-verification model is not
  installed.
- Audio is processed temporarily and deleted after analysis; raw audio is not
  placed in audit records.
- The prototype has no authentication, payments, blockchain, telecom
  interception, banking integration, or production deployment controls.