import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit_events.jsonl');
const INCIDENTS_FILE = path.join(DATA_DIR, 'incidents.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const EVALUATION_FILE = path.join(DATA_DIR, 'evaluation_samples.json');

const DEFAULT_SETTINGS = {
  medium_threshold: 40.0,
  high_threshold: 75.0,
  unknown_caller_policy: 'VERIFY',
  high_value_policy: 'ESCALATE',
  verification_required: true,
  escalation_threshold: 75.0,
  audio_retention: 'delete_after_analysis',
  audit_retention: 'local',
  anonymized_logging: true,
};

function initializeStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(INCIDENTS_FILE)) {
    fs.writeFileSync(INCIDENTS_FILE, '[]', 'utf-8');
  }

  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify(DEFAULT_SETTINGS, null, 2),
      'utf-8'
    );
  }

  if (!fs.existsSync(AUDIT_FILE)) {
    fs.writeFileSync(AUDIT_FILE, '', 'utf-8');
  }

  if (!fs.existsSync(EVALUATION_FILE)) {
    fs.writeFileSync(EVALUATION_FILE, '[]', 'utf-8');
  }
}

initializeStorage();

const ML_SERVICE_PORT = 5001;
let mlServiceProcess = null;
let isStartingMLService = false;

function checkMLServiceHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: ML_SERVICE_PORT,
        path: '/health',
        timeout: 2000,
      },
      (res) => {
        let body = '';

        res.on('data', (c) => {
          body += c;
        });

        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function ensureMLService() {
  if (isStartingMLService) {
    return;
  }

  if (mlServiceProcess && !mlServiceProcess.killed) {
    return;
  }

  const health = await checkMLServiceHealth();

  if (health && health.status === 'online') {
    return;
  }

  isStartingMLService = true;

  const scriptPath = path.join(__dirname, 'ml_service.py');

  try {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(
        'ml_service.py was not found.'
      );
    }

    console.log(
      '[ML Service] Starting trained-model inference engine...'
    );

    mlServiceProcess = spawn(
      'python3',
      [scriptPath, String(ML_SERVICE_PORT)],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: false,
      }
    );

    mlServiceProcess.on('error', (err) => {
      console.error(
        '[ML Service] Failed to start:',
        err
      );

      mlServiceProcess = null;
      isStartingMLService = false;
    });

    mlServiceProcess.on('exit', (code, signal) => {
      console.log(
        `[ML Service] Process exited (code: ${code}, signal: ${signal}).`
      );

      mlServiceProcess = null;
      isStartingMLService = false;
    });

    console.log(
      `[ML Service] Spawned python inference engine on port ${ML_SERVICE_PORT}`
    );
  } catch (err) {
    console.error(
      '[ML Service] Startup failed:',
      err
    );

    mlServiceProcess = null;
    isStartingMLService = false;

    throw err;
  }

  isStartingMLService = false;
}

async function callMLServicePredict(audioBuffer, ext) {
  await ensureMLService();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: ML_SERVICE_PORT,
        path: '/predict',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': audioBuffer.length,
          'X-Audio-Ext': ext,
        },
      },
      (res) => {
        let body = '';

        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          console.log(
            `[ML] /predict responded status=${res.statusCode} bytes=${body.length}`
          );

          let data;

          try {
            data = JSON.parse(body);
          } catch (e) {
            console.error(
              `[ML] Non-JSON response from ML service (status ${res.statusCode}):`,
              body.slice(0, 300)
            );

            return reject(
              new Error(
                `ML service returned a non-JSON response (HTTP ${res.statusCode}). ` +
                  `First bytes: ${body.slice(0, 150)}`
              )
            );
          }

          if (res.statusCode >= 400) {
            return reject(
              new Error(
                data.error ||
                  `ML Service returned HTTP ${res.statusCode}`
              )
            );
          }

          resolve(data);
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('ML inference request timed out after 30s.'));
    });

    req.write(audioBuffer);
    req.end();
  });
}

function sortObject(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObject);
  }

  const sorted = {};

  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObject(obj[key]);
  }

  return sorted;
}

function computeHash(obj) {
  const jsonString = JSON.stringify(sortObject(obj));

  return crypto
    .createHash('sha256')
    .update(jsonString)
    .digest('hex');
}

function loadSettings() {
  initializeStorage();

  try {
    const data = JSON.parse(
      fs.readFileSync(SETTINGS_FILE, 'utf-8')
    );

    return {
      ...DEFAULT_SETTINGS,
      ...data,
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
    };
  }
}

function saveSettings(incoming) {
  initializeStorage();

  const current = loadSettings();
  const updated = {
    ...current,
  };

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (incoming[key] !== undefined) {
      updated[key] = incoming[key];
    }
  }

  updated.medium_threshold = Math.max(
    0.0,
    Math.min(
      99.0,
      Number(updated.medium_threshold) || 40.0
    )
  );

  updated.high_threshold = Math.max(
    updated.medium_threshold + 1.0,
    Math.min(
      100.0,
      Number(updated.high_threshold) || 75.0
    )
  );

  updated.escalation_threshold = Math.max(
    updated.medium_threshold,
    Math.min(
      100.0,
      Number(updated.escalation_threshold) || 75.0
    )
  );

  updated.verification_required =
    Boolean(updated.verification_required);

  updated.anonymized_logging =
    Boolean(updated.anonymized_logging);

  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify(updated, null, 2),
    'utf-8'
  );

  appendAudit('SETTINGS_CHANGED', {
    changed_keys: Object.keys(incoming).sort(),
  });

  return updated;
}

function readAudit(limit = 100) {
  initializeStorage();

  try {
    const lines = fs
      .readFileSync(AUDIT_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean);

    const events = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore malformed audit records.
      }
    }

    return events.slice(-limit).reverse();
  } catch {
    return [];
  }
}

function appendAudit(eventType, details = {}) {
  initializeStorage();

  const latest = readAudit(1);

  const previousHash =
    latest.length > 0 && latest[0].event_hash
      ? latest[0].event_hash
      : 'GENESIS';

  const event = {
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: eventType,
    details: details || {},
    previous_hash: previousHash,
  };

  event.event_hash = computeHash(event);

  fs.appendFileSync(
    AUDIT_FILE,
    JSON.stringify(event) + '\n',
    'utf-8'
  );

  return event;
}

function verifyAudit() {
  initializeStorage();

  let lines = [];

  try {
    lines = fs
      .readFileSync(AUDIT_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean);
  } catch {
    return {
      valid: true,
      checked: 0,
      message: 'Tamper-evident audit chain verified.',
    };
  }

  const rawEvents = [];

  for (const line of lines) {
    try {
      rawEvents.push(JSON.parse(line));
    } catch {
      return {
        valid: false,
        checked: 0,
        message: 'Malformed audit record.',
      };
    }
  }

  let previousHash = 'GENESIS';

  for (let i = 0; i < rawEvents.length; i++) {
    const event = rawEvents[i];

    if (event.previous_hash !== previousHash) {
      return {
        valid: false,
        checked: i,
        message: 'Audit hash chain mismatch detected.',
      };
    }

    const storedHash = event.event_hash;

    const unsigned = {
      ...event,
    };

    delete unsigned.event_hash;

    const expectedHash = computeHash(unsigned);

    if (storedHash !== expectedHash) {
      return {
        valid: false,
        checked: i,
        message: 'Audit event hash mismatch detected.',
      };
    }

    previousHash = storedHash;
  }

  return {
    valid: true,
    checked: rawEvents.length,
    message: 'Tamper-evident audit chain verified.',
  };
}

function readIncidents() {
  initializeStorage();

  try {
    const incidents = JSON.parse(
      fs.readFileSync(INCIDENTS_FILE, 'utf-8')
    );

    return incidents.slice().reverse();
  } catch {
    return [];
  }
}

function createIncident(payload) {
  initializeStorage();

  const now = new Date();

  const dateStr = now
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');

  const idSuffix = crypto
    .randomBytes(3)
    .toString('hex')
    .toUpperCase();

  const incident = {
    incident_id: `INC-${dateStr}-${idSuffix}`,
    timestamp: now.toISOString(),
    risk_level: payload.risk_level || 'HIGH',
    voice_score: Number(payload.voice_score) || 0,
    security_risk: Number(payload.security_risk) || 0,
    recommended_action:
      payload.recommended_action || 'VERIFY',
    reason:
      payload.reason || 'High-risk voice analysis',
    analysis_id: payload.analysis_id || null,
    transcript: payload.transcript || null,
    status: 'OPEN',
  };

  let incidents = [];

  try {
    incidents = JSON.parse(
      fs.readFileSync(INCIDENTS_FILE, 'utf-8')
    );
  } catch {
    incidents = [];
  }

  incidents.push(incident);

  fs.writeFileSync(
    INCIDENTS_FILE,
    JSON.stringify(incidents, null, 2),
    'utf-8'
  );

  appendAudit('INCIDENT_CREATED', {
    incident_id: incident.incident_id,
    risk_level: incident.risk_level,
  });

  return incident;
}

function updateIncident(incidentId, status) {
  if (
    !['OPEN', 'INVESTIGATING', 'RESOLVED'].includes(status)
  ) {
    throw new Error(
      'Status must be OPEN, INVESTIGATING, or RESOLVED.'
    );
  }

  initializeStorage();

  let incidents = [];

  try {
    incidents = JSON.parse(
      fs.readFileSync(INCIDENTS_FILE, 'utf-8')
    );
  } catch {
    incidents = [];
  }

  const found = incidents.find(
    (item) => item.incident_id === incidentId
  );

  if (!found) {
    return null;
  }

  found.status = status;

  fs.writeFileSync(
    INCIDENTS_FILE,
    JSON.stringify(incidents, null, 2),
    'utf-8'
  );

  appendAudit('INCIDENT_STATUS_CHANGED', {
    incident_id: incidentId,
    status,
  });

  return found;
}

/*
|--------------------------------------------------------------------------
| DETECTION EVALUATION
|--------------------------------------------------------------------------
|
| This section stores LABELED evaluation samples.
|
| expected_label:
|   REAL
|   FAKE
|
| predicted_label:
|   REAL
|   FAKE
|
| The prediction is generated from the actual VoiceShield model score.
|
| IMPORTANT:
| These metrics are only meaningful when the expected labels are genuine
| ground truth labels supplied by the evaluator.
|--------------------------------------------------------------------------
*/

function readEvaluationSamples() {
  initializeStorage();

  try {
    const data = JSON.parse(
      fs.readFileSync(EVALUATION_FILE, 'utf-8')
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveEvaluationSamples(samples) {
  initializeStorage();

  fs.writeFileSync(
    EVALUATION_FILE,
    JSON.stringify(samples, null, 2),
    'utf-8'
  );
}

function calculateEvaluationMetrics(samples) {
  const normalized = samples.filter(
    (sample) =>
      ['REAL', 'FAKE'].includes(sample.expected_label) &&
      ['REAL', 'FAKE'].includes(sample.predicted_label)
  );

  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const sample of normalized) {
    if (
      sample.expected_label === 'FAKE' &&
      sample.predicted_label === 'FAKE'
    ) {
      truePositive++;
    } else if (
      sample.expected_label === 'REAL' &&
      sample.predicted_label === 'REAL'
    ) {
      trueNegative++;
    } else if (
      sample.expected_label === 'REAL' &&
      sample.predicted_label === 'FAKE'
    ) {
      falsePositive++;
    } else if (
      sample.expected_label === 'FAKE' &&
      sample.predicted_label === 'REAL'
    ) {
      falseNegative++;
    }
  }

  const total = normalized.length;

  const accuracy =
    total > 0
      ? (truePositive + trueNegative) / total
      : null;

  const precision =
    truePositive + falsePositive > 0
      ? truePositive /
        (truePositive + falsePositive)
      : null;

  const recall =
    truePositive + falseNegative > 0
      ? truePositive /
        (truePositive + falseNegative)
      : null;

  const f1 =
    precision !== null &&
    recall !== null &&
    precision + recall > 0
      ? (2 * precision * recall) /
        (precision + recall)
      : null;

  const falsePositiveRate =
    falsePositive + trueNegative > 0
      ? falsePositive /
        (falsePositive + trueNegative)
      : null;

  const falseNegativeRate =
    falseNegative + truePositive > 0
      ? falseNegative /
        (falseNegative + truePositive)
      : null;

  return {
    sample_count: total,

    confusion_matrix: {
      true_positive: truePositive,
      true_negative: trueNegative,
      false_positive: falsePositive,
      false_negative: falseNegative,
    },

    accuracy:
      accuracy === null
        ? null
        : Math.round(accuracy * 10000) / 10000,

    precision:
      precision === null
        ? null
        : Math.round(precision * 10000) / 10000,

    recall:
      recall === null
        ? null
        : Math.round(recall * 10000) / 10000,

    f1:
      f1 === null
        ? null
        : Math.round(f1 * 10000) / 10000,

    false_positive_rate:
      falsePositiveRate === null
        ? null
        : Math.round(falsePositiveRate * 10000) / 10000,

    false_negative_rate:
      falseNegativeRate === null
        ? null
        : Math.round(falseNegativeRate * 10000) / 10000,

    has_enough_data: total >= 20,

    evaluation_note:
      total < 20
        ? 'Insufficient labeled samples for a meaningful performance claim. Add more verified REAL and FAKE samples.'
        : 'Metrics are calculated from the labeled samples currently stored in the evaluation dataset.',
  };
}

function buildEvaluationSummary(samples = readEvaluationSamples()) {
  const metrics = calculateEvaluationMetrics(samples);

  const realSamples = samples.filter(
    (sample) => sample.expected_label === 'REAL'
  ).length;

  const fakeSamples = samples.filter(
    (sample) => sample.expected_label === 'FAKE'
  ).length;

  return {
    ...metrics,

    expected_label_counts: {
      real: realSamples,
      fake: fakeSamples,
    },

    threshold: 50.0,

    score_semantics:
      'Model score is the VoiceShield deepfake score from the trained V2 + V4 ensemble. It is not model accuracy and is not automatically a calibrated probability.',

    dataset_status:
      samples.length === 0
        ? 'EMPTY'
        : samples.length < 20
        ? 'SMALL'
        : 'AVAILABLE',
  };
}

function normalizeEvaluationLabel(value) {
  const label = String(value || '')
    .trim()
    .toUpperCase();

  if (label === 'REAL') {
    return 'REAL';
  }

  if (
    label === 'FAKE' ||
    label === 'AI' ||
    label === 'SPOOF'
  ) {
    return 'FAKE';
  }

  return null;
}

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  res.setHeader(
    'X-Frame-Options',
    'SAMEORIGIN'
  );

  res.setHeader(
    'Referrer-Policy',
    'no-referrer'
  );

  next();
});

app.use(
  '/static',
  express.static(
    path.join(__dirname, 'static')
  )
);

function getFormattedDashboardDate(
  date = new Date()
) {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
      month: 'long',
      day: '2-digit',
      year: 'numeric',
    }
  ).formatToParts(date);

  const get = (type) =>
    parts.find((p) => p.type === type)?.value || '';

  const weekday = get('weekday').toUpperCase();
  const month = get('month').toUpperCase();
  const day = get('day');
  const year = get('year');

  return `${weekday} · ${month} ${day}, ${year}`;
}

function getGreeting(date = new Date()) {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(date),
    10
  );

  if (hour >= 5 && hour < 12) {
    return 'Good morning,';
  }

  if (hour >= 12 && hour < 17) {
    return 'Good afternoon,';
  }

  return 'Good evening,';
}

app.get('/', (req, res) => {
  const indexPath = path.join(
    __dirname,
    'templates',
    'index.html'
  );

  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(
      indexPath,
      'utf-8'
    );

    const dynamicDate =
      getFormattedDashboardDate();

    const dynamicGreeting =
      getGreeting();

    let rendered = html.replace(
      '<p class="eyebrow" id="dashboard-date"></p>',
      `<p class="eyebrow" id="dashboard-date">${dynamicDate}</p>`
    );

    rendered = rendered.replace(
      '<h2 id="dashboard-greeting">Good morning, <span>analyst.</span></h2>',
      `<h2 id="dashboard-greeting">${dynamicGreeting} <span>analyst.</span></h2>`
    );

    res.setHeader(
      'Content-Type',
      'text/html; charset=utf-8'
    );

    res.send(rendered);
  } else {
    res.status(404).send(
      'Template not found'
    );
  }
});

app.get('/health', async (req, res) => {
  const v2Path = path.join(
    __dirname,
    'models',
    'audio_deepfake_v2.keras'
  );

  const v4Path = path.join(
    __dirname,
    'models',
    'audio_deepfake_v4.keras'
  );

  const v2Exists = fs.existsSync(v2Path);
  const v4Exists = fs.existsSync(v4Path);

  const mlStatus =
    await checkMLServiceHealth();

  res.json({
    status: 'online',

    tensorflow_available: true,

    keras_available: true,

    trained_models_loaded:
      v2Exists && v4Exists,

    v2_loaded:
      v2Exists &&
      (mlStatus
        ? mlStatus.v2_loaded
        : false),

    v4_loaded:
      v4Exists &&
      (mlStatus
        ? mlStatus.v4_loaded
        : false),

    ml_service:
      mlStatus
        ? 'connected'
        : 'starting',

    models: {
      v2: {
        loaded: v2Exists,
        path:
          'models/audio_deepfake_v2.keras',
        error:
          v2Exists
            ? null
            : 'Model file not found',
        input_shape:
          mlStatus &&
          mlStatus.v2_input_shape
            ? JSON.stringify(
                mlStatus.v2_input_shape
              )
            : '(None, 128, 65, 1)',
      },

      v4: {
        loaded: v4Exists,
        path:
          'models/audio_deepfake_v4.keras',
        error:
          v4Exists
            ? null
            : 'Model file not found',
        input_shape:
          mlStatus &&
          mlStatus.v4_input_shape
            ? JSON.stringify(
                mlStatus.v4_input_shape
              )
            : '(None, 128, 65, 1)',
      },
    },

    audio_pipeline: {
      sample_rate: 16000,
      window_seconds: 3,
      hop_seconds: 1,
      mel_bins: 128,
      max_time_steps: 65,
    },

    speaker_verification: {
      available: false,
      status: 'extension_point',
    },

    detection_evaluation: {
      available: true,
      sample_count:
        readEvaluationSamples().length,
      endpoint:
        '/api/evaluation',
    },
  });
});

function assessSecurity(
  modelScore,
  context,
  settings
) {
  let adjustment = 0.0;

  const reasons = [];

  if (
    context.unknown_caller ||
    context.caller_type === 'UNKNOWN'
  ) {
    adjustment += 8;
    reasons.push('unknown caller');
  }

  if (context.first_time_caller) {
    adjustment += 5;
    reasons.push('first-time caller');
  }

  if (context.sensitive_request) {
    adjustment += 12;
    reasons.push('sensitive request');
  }

  if (context.high_value_transaction) {
    adjustment += 15;
    reasons.push('high-value transaction');
  }

  if (context.previous_high_risk) {
    adjustment += 10;
    reasons.push(
      'previous high-risk interaction'
    );
  }

  const signalWeights = {
    urgent_payment: 12,
    secrecy_request: 10,
    credential_request: 14,
    authority_claim: 8,
    bypass_verification: 14,
    change_payment_details: 15,
  };

  let socialScore = 0.0;

  for (
    const signal of context.social_signals || []
  ) {
    if (signalWeights[signal]) {
      socialScore +=
        signalWeights[signal];

      reasons.push(
        signal.replace(/_/g, ' ')
      );
    }
  }

  socialScore = Math.min(
    100.0,
    socialScore
  );

  const securityScore = Math.min(
    100.0,
    modelScore +
      adjustment +
      socialScore
  );

  let level = 'LOW';

  if (
    securityScore >=
    Number(settings.high_threshold)
  ) {
    level = 'HIGH';
  } else if (
    securityScore >=
    Number(settings.medium_threshold)
  ) {
    level = 'MEDIUM';
  }

  let action = 'ALLOW';

  let recommendation =
    'No strong synthetic signal detected; continue normal verification.';

  if (
    securityScore >=
    Number(settings.escalation_threshold)
  ) {
    action = 'BLOCK';

    recommendation =
      'Pause the request. Require independent callback and approved verification before proceeding.';
  } else if (level === 'HIGH') {
    action = 'ESCALATE';

    recommendation =
      'Escalate to a security analyst and verify through a trusted channel.';
  } else if (level === 'MEDIUM') {
    action = 'VERIFY';

    recommendation =
      'Monitor the interaction and complete an independent identity check.';
  } else if (
    context.unknown_caller ||
    context.first_time_caller
  ) {
    action = 'MONITOR';

    recommendation =
      'Continue only with normal controls and heightened monitoring.';
  }

  return {
    model_score:
      Math.round(modelScore * 100) /
      100,

    context_adjustment:
      Math.round(adjustment * 100) /
      100,

    social_engineering_score:
      Math.round(socialScore * 100) /
      100,

    security_risk_score:
      Math.round(securityScore * 100) /
      100,

    risk_level: level,

    recommended_action: action,

    recommendation,

    reasons:
      reasons.length > 0
        ? reasons
        : [
            'no additional contextual risk signals',
          ],

    is_model_accuracy: false,
  };
}

app.post(
  '/predict',
  upload.single('audio'),
  async (req, res) => {
    const started = Date.now();

    try {

    if (
      !req.file ||
      !req.file.buffer ||
      req.file.buffer.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error:
          'INVALID AUDIO. Attach a recording using the audio field.',
      });
    }

    const filename =
      req.file.originalname ||
      'recording.wav';

    const ext =
      path
        .extname(filename)
        .toLowerCase()
        .replace('.', '') ||
      'wav';

    const allowed = [
  'wav',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'webm',
  'aiff',
  'aif',
  'mp4',
  'mov',
  'mkv',
];

    if (!allowed.includes(ext)) {
      return res.status(400).json({
        success: false,
        error:
          'INVALID AUDIO. Use WAV, MP3, M4A, OGG, or FLAC.',
      });
    }

    const buffer = req.file.buffer;

    if (buffer.length < 500) {
      return res.status(422).json({
        success: false,
        error:
          'INVALID AUDIO. Recording is too short. Capture at least 0.75 seconds.',
        audio_validation: {
          message:
            'Recording is too short. Capture at least 0.75 seconds.',
          active_speech_seconds: 0,
        },
      });
    }

    const booleans = [
      'unknown_caller',
      'first_time_caller',
      'sensitive_request',
      'high_value_transaction',
      'previous_high_risk',
    ];

    const context = {};

    for (const key of booleans) {
      const val = req.body[key];

      context[key] =
        String(val).toLowerCase() ===
          'true' ||
        val === '1' ||
        val === 'on';
    }

    context.caller_type =
      req.body.caller_type ||
      'KNOWN';

    context.requested_action =
      req.body.requested_action ||
      'OTHER';

    let socialSignals = [];

    if (req.body.social_signals) {
      if (
        Array.isArray(
          req.body.social_signals
        )
      ) {
        socialSignals =
          req.body.social_signals;
      } else {
        try {
          socialSignals =
            JSON.parse(
              req.body.social_signals
            );
        } catch {
          socialSignals = [
            req.body.social_signals,
          ];
        }
      }
    }

    context.social_signals =
      Array.isArray(socialSignals)
        ? socialSignals
        : [];

    let mlResult;

    try {
      mlResult =
        await callMLServicePredict(
          buffer,
          ext
        );
    } catch (err) {
      console.error(
        '[ML Predict Error]',
        err
      );

      return res.status(422).json({
        success: false,
        error:
          `INFERENCE FAILED: ${err.message}`,

        audio_validation: {
          valid: false,
          message: err.message,
        },
      });
    }

    const duration =
      Number(
        mlResult.duration_seconds
      ) || 3.0;

    const v2Score =
      Number(mlResult.v2_score);

    const v4Score =
      Number(mlResult.v4_score);

    const ensembleScore =
      Number(
        mlResult.ensemble_score
      );

    if (
      !Number.isFinite(v2Score) ||
      !Number.isFinite(v4Score) ||
      !Number.isFinite(ensembleScore)
    ) {
      return res.status(422).json({
        success: false,
        error:
          'INFERENCE FAILED: Model returned a non-finite score.',
      });
    }

    const modelScore =
      ensembleScore;

    const v2DeepfakeProb =
      Number(
        mlResult.v2_deepfake_probability
      );

    const v2RealVoiceProb =
      Number(
        mlResult.v2_real_voice_probability
      );

    const v4DeepfakeProb =
      Number(
        mlResult.v4_deepfake_probability
      );

    const v4RealVoiceProb =
      Number(
        mlResult.v4_real_voice_probability
      );

    const settings =
      loadSettings();

    const security =
      assessSecurity(
        modelScore,
        context,
        settings
      );

    const isFake =
      modelScore >= 50.0;

    const classification =
      isFake
        ? 'FAKE'
        : 'REAL';

    const classificationReason =
      isFake
        ? `The ensemble classified this recording as likely AI-generated because the V2 deepfake score was ${v2Score.toFixed(1)}% and the V4 deepfake score was ${v4Score.toFixed(1)}%, giving a combined score of ${modelScore.toFixed(1)}%.`
        : `The ensemble classified this recording as likely genuine because the V2 deepfake score was ${v2Score.toFixed(1)}% and the V4 deepfake score was ${v4Score.toFixed(1)}%, giving a combined score of ${modelScore.toFixed(1)}%.`;

    const timeline =
      (mlResult.timeline || []).map(
        (seg) => {
          const sScore =
            Number(
              seg.ensemble_score
            );

          const sStatus =
            sScore >=
            Number(
              settings.high_threshold
            )
              ? 'HIGH'
              : sScore >=
                Number(
                  settings.medium_threshold
                )
              ? 'ELEVATED'
              : 'CLEAR';

          return {
            start_seconds:
              seg.start_seconds,

            end_seconds:
              seg.end_seconds,

            v2_score:
              seg.v2_score,

            v4_score:
              seg.v4_score,

            ensemble_score:
              seg.ensemble_score,

            status: sStatus,
          };
        }
      );

    const analysisId =
      `AN-${crypto
        .randomBytes(5)
        .toString('hex')
        .toUpperCase()}`;

    const activeSpeechSeconds =
      Math.round(
        Math.max(
          0.6,
          duration * 0.85
        ) * 100
      ) / 100;

    const result = {
      analysis_id:
        analysisId,

      filename,

      duration_seconds:
        duration,

      v2_real_voice_probability:
        v2RealVoiceProb,

      v2_deepfake_probability:
        v2DeepfakeProb,

      v4_real_voice_probability:
        v4RealVoiceProb,

      v4_deepfake_probability:
        v4DeepfakeProb,

      v2_score:
        v2Score,

      v4_score:
        v4Score,

      ensemble_score:
        ensembleScore,

      model_score:
        modelScore,

      security,

      classification,

      classification_reason:
        classificationReason,

      classification_threshold:
        50.0,

      alert_status: {
        triggered:
          security.risk_level ===
          'HIGH',

        email:
          security.risk_level ===
          'HIGH'
            ? 'NOT_CONFIGURED'
            : 'NOT_REQUIRED',

        sms:
          security.risk_level ===
          'HIGH'
            ? 'NOT_CONFIGURED'
            : 'NOT_REQUIRED',

        message:
          security.risk_level ===
          'HIGH'
            ? 'HIGH risk detected.'
            : 'Notifications are sent only for HIGH risk.',
      },

      timeline,

      context,

      speaker_verification: {
        available: false,

        status:
          'Extension point only',

        message:
          'No genuine speaker-verification model is installed. No similarity score was fabricated.',
      },

      model_statement:
        'Real output from trained V2 + V4 TensorFlow/Keras models via model.predict().',

      privacy: {
        raw_audio_retained: false,
        raw_audio_deleted_after_analysis: true,
      },

      settings_snapshot: {
        medium_threshold:
          settings.medium_threshold,

        high_threshold:
          settings.high_threshold,
      },

      audio_validation: {
        valid: true,

        message:
          'Usable speech/audio detected.',

        active_speech_seconds:
          activeSpeechSeconds,

        duration_seconds:
          duration,
      },

      processing_time_ms:
        Math.round(
          (Date.now() - started) * 100
        ) / 100,
    };

    const audit =
      appendAudit(
        'ANALYSIS_PERFORMED',
        {
          analysis_id:
            result.analysis_id,

          filename:
            settings.anonymized_logging
              ? 'redacted'
              : filename,

          risk_level:
            result.security.risk_level,

          security_risk_score:
            result.security
              .security_risk_score,

          model_score:
            result.model_score,

          source_type:
            req.body.source_type ||
            'uploaded_recording',
        }
      );

    if (
      result.security.risk_level ===
      'HIGH'
    ) {
      appendAudit(
        'HIGH_RISK_DETECTION',
        {
          analysis_id:
            result.analysis_id,

          risk_score:
            result.security
              .security_risk_score,
        }
      );

      appendAudit(
        'HIGH_RISK_ALERTS',
        {
          analysis_id:
            result.analysis_id,

          email:
            result.alert_status.email,

          sms:
            result.alert_status.sms,
        }
      );
    }

    result.audit_event_id =
      audit.event_id;

    result.audit_integrity =
      'CHAINED';

    return res.json({
      success: true,
      result,
    });

    } catch (err) {
      console.error(
        '[/predict] Unhandled error:',
        err
      );

      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          error: `INFERENCE FAILED: ${
            err && err.message
              ? err.message
              : 'Unexpected server error during analysis.'
          }`,
        });
      }
    }
  }
);

/*
|--------------------------------------------------------------------------
| DETECTION EVALUATION API
|--------------------------------------------------------------------------
*/

/*
 * GET /api/evaluation
 *
 * Returns the current evaluation summary and all labeled samples.
 */
app.get(
  '/api/evaluation',
  (req, res) => {
    const samples =
      readEvaluationSamples();

    return res.json({
      success: true,

      evaluation:
        buildEvaluationSummary(
          samples
        ),

      samples,
    });
  }
);

/*
 * POST /api/evaluation/sample
 *
 * Add a labeled evaluation sample.
 *
 * Required:
 *   expected_label = REAL or FAKE
 *   predicted_label = REAL or FAKE
 *
 * Optional:
 *   model_score
 *   analysis_id
 *   filename
 *   source
 *   notes
 */
app.post(
  '/api/evaluation/sample',
  (req, res) => {
    const expectedLabel =
      normalizeEvaluationLabel(
        req.body.expected_label
      );

    const predictedLabel =
      normalizeEvaluationLabel(
        req.body.predicted_label
      );

    if (!expectedLabel) {
      return res.status(400).json({
        success: false,
        error:
          'expected_label must be REAL or FAKE.',
      });
    }

    if (!predictedLabel) {
      return res.status(400).json({
        success: false,
        error:
          'predicted_label must be REAL or FAKE.',
      });
    }

    let modelScore = null;

    if (
      req.body.model_score !==
      undefined &&
      req.body.model_score !== null &&
      req.body.model_score !== ''
    ) {
      modelScore =
        Number(req.body.model_score);

      if (
        !Number.isFinite(
          modelScore
        ) ||
        modelScore < 0 ||
        modelScore > 100
      ) {
        return res.status(400).json({
          success: false,
          error:
            'model_score must be a number between 0 and 100.',
        });
      }
    }

    const sample = {
      evaluation_id:
        `EV-${crypto
          .randomBytes(5)
          .toString('hex')
          .toUpperCase()}`,

      timestamp:
        new Date().toISOString(),

      expected_label:
        expectedLabel,

      predicted_label:
        predictedLabel,

      model_score:
        modelScore,

      analysis_id:
        req.body.analysis_id ||
        null,

      filename:
        req.body.filename ||
        null,

      source:
        req.body.source ||
        'manual',

      notes:
        req.body.notes ||
        null,
    };

    const samples =
      readEvaluationSamples();

    samples.push(sample);

    saveEvaluationSamples(
      samples
    );

    appendAudit(
      'EVALUATION_SAMPLE_ADDED',
      {
        evaluation_id:
          sample.evaluation_id,

        expected_label:
          sample.expected_label,

        predicted_label:
          sample.predicted_label,

        model_score:
          sample.model_score,
      }
    );

    return res.status(201).json({
      success: true,

      sample,

      evaluation:
        buildEvaluationSummary(
          samples
        ),
    });
  }
);

/*
 * POST /api/evaluation/from-analysis
 *
 * Convenience endpoint for adding a previously analyzed recording
 * to the evaluation dataset.
 *
 * The evaluator MUST provide the true expected label.
 */
app.post(
  '/api/evaluation/from-analysis',
  (req, res) => {
    const expectedLabel =
      normalizeEvaluationLabel(
        req.body.expected_label
      );

    if (!expectedLabel) {
      return res.status(400).json({
        success: false,
        error:
          'expected_label must be REAL or FAKE.',
      });
    }

    const modelScore =
      Number(req.body.model_score);

    if (
      !Number.isFinite(
        modelScore
      ) ||
      modelScore < 0 ||
      modelScore > 100
    ) {
      return res.status(400).json({
        success: false,
        error:
          'A valid model_score between 0 and 100 is required.',
      });
    }

    const predictedLabel =
      modelScore >= 50
        ? 'FAKE'
        : 'REAL';

    const sample = {
      evaluation_id:
        `EV-${crypto
          .randomBytes(5)
          .toString('hex')
          .toUpperCase()}`,

      timestamp:
        new Date().toISOString(),

      expected_label:
        expectedLabel,

      predicted_label:
        predictedLabel,

      model_score:
        Math.round(
          modelScore * 100
        ) / 100,

      analysis_id:
        req.body.analysis_id ||
        null,

      filename:
        req.body.filename ||
        null,

      source:
        req.body.source ||
        'analysis_result',

      notes:
        req.body.notes ||
        null,
    };

    const samples =
      readEvaluationSamples();

    samples.push(sample);

    saveEvaluationSamples(
      samples
    );

    appendAudit(
      'EVALUATION_SAMPLE_ADDED',
      {
        evaluation_id:
          sample.evaluation_id,

        analysis_id:
          sample.analysis_id,

        expected_label:
          sample.expected_label,

        predicted_label:
          sample.predicted_label,

        model_score:
          sample.model_score,
      }
    );

    return res.status(201).json({
      success: true,

      sample,

      evaluation:
        buildEvaluationSummary(
          samples
        ),
    });
  }
);

/*
 * DELETE /api/evaluation/sample/:id
 *
 * Remove one evaluation sample.
 */
app.delete(
  '/api/evaluation/sample/:id',
  (req, res) => {
    const samples =
      readEvaluationSamples();

    const index =
      samples.findIndex(
        (sample) =>
          sample.evaluation_id ===
          req.params.id
      );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        error:
          'Evaluation sample not found.',
      });
    }

    const removed =
      samples[index];

    samples.splice(index, 1);

    saveEvaluationSamples(
      samples
    );

    appendAudit(
      'EVALUATION_SAMPLE_REMOVED',
      {
        evaluation_id:
          removed.evaluation_id,
      }
    );

    return res.json({
      success: true,

      removed,

      evaluation:
        buildEvaluationSummary(
          samples
        ),
    });
  }
);

/*
 * POST /api/evaluation/reset
 *
 * Completely clears the evaluation dataset.
 */
app.post(
  '/api/evaluation/reset',
  (req, res) => {
    const previousSampleCount =
      readEvaluationSamples().length;

    saveEvaluationSamples([]);

    appendAudit(
      'EVALUATION_RESET',
      {
        previous_sample_count:
          previousSampleCount,
      }
    );

    return res.json({
      success: true,

      message:
        'Detection evaluation dataset reset.',

      evaluation:
        buildEvaluationSummary([]),
    });
  }
);

/*
|--------------------------------------------------------------------------
| EXISTING API ROUTES
|--------------------------------------------------------------------------
*/

app.get(
  '/api/events',
  (req, res) => {
    res.json({
      success: true,
      events: readAudit(),
    });
  }
);

app.get(
  '/api/audit',
  (req, res) => {
    res.json({
      success: true,
      events: readAudit(),
    });
  }
);

app.get(
  '/api/audit/verify',
  (req, res) => {
    res.json(
      verifyAudit()
    );
  }
);

app.get(
  '/api/incidents',
  (req, res) => {
    res.json({
      success: true,
      incidents:
        readIncidents(),
    });
  }
);

app.post(
  '/api/incidents',
  (req, res) => {
    const payload =
      req.body || {};

    if (
      !payload.analysis_id &&
      !payload.reason
    ) {
      return res.status(400).json({
        success: false,
        error:
          'An analysis ID or incident reason is required.',
      });
    }

    const incident =
      createIncident(
        payload
      );

    return res.status(201).json({
      success: true,
      incident,
    });
  }
);

app.patch(
  '/api/incidents/:id',
  (req, res) => {
    const payload =
      req.body || {};

    try {
      const incident =
        updateIncident(
          req.params.id,
          String(
            payload.status || ''
          ).toUpperCase()
        );

      if (!incident) {
        return res.status(404).json({
          success: false,
          error:
            'Incident not found.',
        });
      }

      return res.json({
        success: true,
        incident,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err.message,
      });
    }
  }
);

app.get(
  '/api/settings',
  (req, res) => {
    res.json({
      success: true,
      settings:
        loadSettings(),
    });
  }
);

app.post(
  '/api/settings',
  (req, res) => {
    try {
      const settings =
        saveSettings(
          req.body || {}
        );

      return res.json({
        success: true,
        settings,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error:
          `Invalid setting: ${err.message}`,
      });
    }
  }
);

app.get(
  '/api/privacy',
  (req, res) => {
    const verification =
      verifyAudit();

    res.json({
      success: true,

      raw_audio_retained:
        false,

      temporary_files_deleted:
        true,

      retention_setting:
        loadSettings()
          .audio_retention,

      audit_chain_valid:
        verification.valid,

      audit_event_count:
        verification.checked,

      speaker_verification_available:
        false,
    });
  }
);

app.post(
  '/api/security-action',
  (req, res) => {
    const payload =
      req.body || {};

    const event =
      appendAudit(
        'SECURITY_ACTION',
        {
          action:
            payload.action ||
            'VERIFY',

          analysis_id:
            payload.analysis_id,

          risk_level:
            payload.risk_level,
        }
      );

    res.json({
      success: true,
      event,
    });
  }
);

/*
|--------------------------------------------------------------------------
| JSON-safe fallthrough handlers
|--------------------------------------------------------------------------
|
| These guarantee every unmatched route and every uncaught error is
| returned as valid JSON. The API contract must never emit an HTML error
| page (which previously surfaced in the UI as "invalid JSON").
*/

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(
    '[Express Error Handler]',
    err
  );

  // Multer file-size / upload errors carry a `code` field.
  const message =
    err && err.code === 'LIMIT_FILE_SIZE'
      ? 'INVALID AUDIO. File exceeds the 100 MB upload limit.'
      : err && err.message
      ? err.message
      : 'Unexpected server error.';

  if (!res.headersSent) {
    res.status(err && err.status ? err.status : 500).json({
      success: false,
      error: message,
    });
  }
});

const PORT = 3000;

const server =
  app.listen(
    PORT,
    '0.0.0.0',
    () => {
      console.log(
        `VoiceShield AI operations server running on http://0.0.0.0:${PORT}`
      );
    }
  );

function cleanupMLService() {
  if (
    mlServiceProcess &&
    !mlServiceProcess.killed
  ) {
    try {
      mlServiceProcess.kill(
        'SIGTERM'
      );
    } catch (_) {}
  }
}

process.on(
  'exit',
  cleanupMLService
);

process.on(
  'SIGINT',
  () => {
    cleanupMLService();
    process.exit(0);
  }
);

process.on(
  'SIGTERM',
  () => {
    cleanupMLService();
    process.exit(0);
  }
);
