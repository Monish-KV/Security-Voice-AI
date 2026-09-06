const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { health: null, result: null, incidents: [], events: [], mediaRecorder: null, liveStream: null, liveBusy: false };

const pageMeta = {
  dashboard: ["OVERVIEW", "Command center"],
  analysis: ["VOICE INTEGRITY", "Analyze a recording"],
  transaction: ["SECURITY OPERATIONS", "Transaction protection"],
  live: ["PROTOTYPE MODE", "Near-real-time analysis"],
  incidents: ["CASE MANAGEMENT", "Incident center"],
  audit: ["GOVERNANCE", "Audit trail"],
  privacy: ["GOVERNANCE", "Privacy center"],
  evaluation: ["GOVERNANCE", "Detection evaluation"],
  settings: ["GOVERNANCE", "Settings"],
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
}

function formatTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function setView(view) {
  const meta = pageMeta[view] || pageMeta.dashboard;
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.nav === view));
  $("#page-kicker").textContent = meta[0];
  $("#page-title").textContent = meta[1];
  history.replaceState({}, "", `#${view}`);
  if (view === "incidents") loadIncidents();
  if (view === "audit") loadAudit();
  if (view === "privacy") loadPrivacy();
  if (view === "evaluation") loadEvaluation();
  if (view === "settings") loadSettings();
}

$$("[data-nav]").forEach((button) => button.addEventListener("click", (event) => {
  event.preventDefault();
  setView(button.dataset.nav);
}));

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function statusText(loaded) {
  return loaded ? "LOADED" : "MISSING";
}

async function loadHealth() {
  try {
    state.health = await api("/health");
    const { models, tensorflow_available: tensorflow } = state.health;
    const ready = models.v2.loaded && models.v4.loaded;
    $("#header-health").textContent = ready ? "All systems operational" : "Models require attention";
    $("#dash-v2").textContent = statusText(models.v2.loaded);
    $("#dash-v4").textContent = statusText(models.v4.loaded);
    $("#dash-v2").className = `health-state ${models.v2.loaded ? "good" : "orange"}`;
    $("#dash-v4").className = `health-state ${models.v4.loaded ? "good" : "orange"}`;
    $("#model-stack-status").textContent = ready ? "READY" : "ACTION REQUIRED";
    $("#settings-tf").textContent = tensorflow ? "AVAILABLE" : "MISSING";
    $("#settings-v2").textContent = statusText(models.v2.loaded);
    $("#settings-v4").textContent = statusText(models.v4.loaded);
  } catch (error) {
    $("#header-health").textContent = "Health check unavailable";
  }
}

function renderDashboard() {
  const events = state.events.filter((event) => event.event_type === "ANALYSIS_PERFORMED");
  const high = events.filter((event) => (event.details?.security_risk_score || 0) >= 75);
  $("#dash-analyses").textContent = events.length;
  $("#dash-high").textContent = high.length;
  $("#dash-threat").textContent = high.length ? "ELEVATED" : "CLEAR";
  $("#dash-threat-note").textContent = high.length ? `${high.length} high-risk event${high.length === 1 ? "" : "s"} in the audit stream` : "No active high-risk events";
  $("#dash-integrity").textContent = state.auditValid === false ? "CHECK" : "VALID";
  $("#dash-integrity").className = `big-number ${state.auditValid === false ? "orange" : "teal"}`;
  $("#dash-integrity-note").textContent = state.auditChecked ? `${state.auditChecked} chained record${state.auditChecked === 1 ? "" : "s"} verified` : "Hash chain status";
  const rows = events.slice(0, 6).map((event) => {
    const detail = event.details || {};
    const risk = Number(detail.security_risk_score || 0);
    return `<tr><td>${escapeHtml(detail.analysis_id || event.event_id.slice(0, 12))}</td><td>${formatTime(event.timestamp)}</td><td>${Number(detail.model_score || 0).toFixed(1)}%</td><td>${risk.toFixed(1)}%</td><td><span class="table-status ${risk >= 75 ? "high" : risk >= 40 ? "medium" : "low"}">${risk >= 75 ? "HIGH" : risk >= 40 ? "MEDIUM" : "LOW"}</span></td></tr>`;
  }).join("");
  $("#recent-analyses").innerHTML = rows || '<tr><td colspan="5" class="empty-state">No analyses recorded yet. Start with an audio recording.</td></tr>';
}

async function loadEvents() {
  try {
    const data = await api("/api/events");
    state.events = data.events || [];
    const verification = await api("/api/audit/verify");
    state.auditValid = verification.valid;
    state.auditChecked = verification.checked;
    renderDashboard();
  } catch (error) {
    console.warn("Could not load events", error);
  }
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const fileInput = $("#audio-file");
const dropZone = $("#drop-zone");
function setFile(file) {
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  $("#selected-name").textContent = file.name;
  $("#selected-meta").textContent = `${formatBytes(file.size)} · ready for analysis`;
  $("#drop-title").textContent = "Recording selected";
  $("#drop-subtitle").textContent = "Choose another file or run the analysis";
  $("#selected-file").classList.remove("hidden");
  $("#analyze-button").disabled = false;
  $("#error-panel").classList.add("hidden");
}
fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
["dragenter", "dragover"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
}));
dropZone.addEventListener("drop", (event) => setFile(event.dataTransfer.files[0]));
$("#clear-file").addEventListener("click", () => {
  fileInput.value = "";
  $("#selected-file").classList.add("hidden");
  $("#analyze-button").disabled = true;
  $("#drop-title").textContent = "Drop an audio file here";
  $("#drop-subtitle").textContent = "or browse from your device";
});

function setLoading(loading) {
  $("#analyze-button").disabled = loading || !fileInput.files.length;
  $(".button-label", $("#analyze-button")).classList.toggle("hidden", loading);
  $(".button-loading", $("#analyze-button")).classList.toggle("hidden", !loading);
}

function showError(message) {
  $("#error-panel").textContent = message;
  $("#error-panel").classList.remove("hidden");
}

function finiteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Analysis response contains an invalid ${fieldName}.`);
  return number;
}

function renderTimeline(items) {
  $("#timeline").innerHTML = (items || []).map((item) => {
    const start = finiteNumber(item.start_seconds, "timeline start");
    const end = finiteNumber(item.end_seconds, "timeline end");
    const ensemble = finiteNumber(item.ensemble_score, "timeline ensemble score");
    return `<div class="timeline-item ${item.status === "HIGH" ? "high" : ""}"><b>${escapeHtml(item.status)}</b><small>${start}s–${end}s<br>${ensemble.toFixed(1)}% model</small></div>`;
  }).join("") || '<div class="empty-state">No timeline segments.</div>';
}

function renderResult(result) {
  if (!result || !result.security) throw new Error("Analysis response is missing the result payload.");
  state.result = result;
  const model = finiteNumber(result.model_score, "ensemble score");
  const security = finiteNumber(result.security.security_risk_score, "security risk score");
  const v2 = finiteNumber(result.v2_score, "V2 prediction");
  const v4 = finiteNumber(result.v4_score, "V4 prediction");
  const duration = finiteNumber(result.duration_seconds, "duration");
  const processing = finiteNumber(result.processing_time_ms, "processing time");
  const risk = result.security.risk_level;
  $("#result-file-title").textContent = result.filename;
  $("#result-id").textContent = result.analysis_id;
  $("#ensemble-score").textContent = model.toFixed(1);
  $("#security-score").textContent = security.toFixed(1);
  $("#v2-score").textContent = `${v2.toFixed(1)}%`;
  $("#v4-score").textContent = `${v4.toFixed(1)}%`;
  $("#result-time").textContent = `${processing.toFixed(2)}ms`;
  $("#result-filename").textContent = result.filename;
  $("#result-duration").textContent = `${duration.toFixed(2)}s`;
  $("#score-fill").style.width = `${model}%`;
  $("#security-fill").style.width = `${security}%`;
  $("#risk-label").textContent = risk;
  const riskColor = risk === "HIGH" ? "var(--red)" : risk === "MEDIUM" ? "var(--orange)" : "var(--teal)";
  $("#risk-pill").style.color = riskColor;
  $("#recommended-action").textContent = result.security.recommended_action;
  $("#recommendation").textContent = result.security.recommendation;
  const context = result.context || {};
  const signals = Array.isArray(context.social_signals) ? context.social_signals : [];
  const modelEvidence = [
    `V2 deepfake score: ${v2.toFixed(1)}/100`,
    `V4 deepfake score: ${v4.toFixed(1)}/100`,
    `Ensemble model score: ${model.toFixed(1)}/100`,
  ];
  const contextEvidence = [
    `Caller: ${context.caller_type === "UNKNOWN" ? "Unknown" : "Known"}`,
    `Interaction: ${context.first_time_caller ? "First-time caller" : "Previous interaction"}`,
    `Request: ${context.sensitive_request ? "Sensitive request" : "Normal request"}${context.requested_action && context.requested_action !== "OTHER" ? ` (${context.requested_action})` : ""}`,
    `Transaction: ${context.high_value_transaction ? "High-value transaction" : "Normal value"}`,
    `History: ${context.previous_high_risk ? "Previous high-risk interaction" : "No previous high-risk interaction"}`,
  ];
  const socialLabels = {
    urgent_payment: "Urgent payment request",
    credential_request: "Credential request",
    secrecy_request: "Secrecy / pressure",
    authority_claim: "Authority claim",
    bypass_verification: "Verification bypass",
    change_payment_details: "Payment-detail change",
  };
  const socialEvidence = signals.map((signal) => socialLabels[signal] || signal).filter(Boolean);
  const renderEvidence = (selector, items, emptyText) => {
    $(selector).innerHTML = (items.length ? items : [emptyText]).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  };
  renderEvidence("#model-evidence", modelEvidence, "No model evidence available.");
  renderEvidence("#context-evidence", contextEvidence, "No context signals selected.");
  renderEvidence("#social-evidence", socialEvidence, "No social-engineering indicators selected.");
  $("#model-statement").textContent = result.model_statement;
  renderTimeline(result.timeline);
  $("#result-panel").classList.remove("hidden");
  $("#result-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function formContext() {
  const form = $("#analysis-form");
  const data = new FormData(form);
  const values = {};
  ["caller_type", "requested_action", "first_time_caller", "sensitive_request", "high_value_transaction", "previous_high_risk"].forEach((name) => {
    const input = form.elements[name];
    values[name] = input.type === "checkbox" ? input.checked : input.value;
  });
  values.social_signals = $$(".signal-chip input:checked").map((input) => input.value);
  return values;
}

$("#analysis-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  $("#result-panel").classList.add("hidden");
  setLoading(true);
  const body = new FormData();
  body.append("audio", fileInput.files[0]);
  const context = formContext();
  Object.entries(context).forEach(([key, value]) => body.append(key, Array.isArray(value) ? JSON.stringify(value) : value));
  try {
    const data = await api("/predict", { method: "POST", body });
    if (!data.result) throw new Error("Analysis response did not include a result payload.");
    renderResult(data.result);
    await loadEvents();
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
});

function clearError() { $("#error-panel").classList.add("hidden"); $("#error-panel").textContent = ""; }

$("#create-incident").addEventListener("click", async () => {
  if (!state.result) return;
  try {
    const result = state.result;
    await api("/api/incidents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      analysis_id: result.analysis_id, risk_level: result.security.risk_level, voice_score: result.model_score,
      security_risk: result.security.security_risk_score, recommended_action: result.security.recommended_action,
      reason: result.security.reasons.join(" · "),
    }) });
    $("#create-incident").textContent = "Incident created ✓";
    await loadIncidents();
    await loadEvents();
  } catch (error) { showError(error.message); }
});

$$("[data-action='security']").forEach((button) => button.addEventListener("click", async () => {
  if (!state.result) return;
  try {
    await api("/api/security-action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: button.dataset.value, analysis_id: state.result.analysis_id, risk_level: state.result.security.risk_level }) });
    button.textContent = `${button.textContent} ✓`;
    await loadEvents();
  } catch (error) { showError(error.message); }
}));

$("#print-report").addEventListener("click", () => window.print());

async function loadIncidents() {
  try {
    const data = await api("/api/incidents");
    state.incidents = data.incidents || [];
    const open = state.incidents.filter((incident) => incident.status !== "RESOLVED").length;
    $("#incident-count").textContent = `${open} OPEN`;
    $("#incidents-table").innerHTML = state.incidents.map((incident) => `<tr data-incident="${incident.incident_id}"><td>${incident.incident_id}</td><td>${formatTime(incident.timestamp)}</td><td><span class="table-status high">${incident.risk_level}</span></td><td>${Number(incident.voice_score || 0).toFixed(1)}% / ${Number(incident.security_risk || 0).toFixed(1)}%</td><td>${escapeHtml(incident.recommended_action)}</td><td><select class="incident-status" data-id="${incident.incident_id}"><option ${incident.status === "OPEN" ? "selected" : ""}>OPEN</option><option ${incident.status === "INVESTIGATING" ? "selected" : ""}>INVESTIGATING</option><option ${incident.status === "RESOLVED" ? "selected" : ""}>RESOLVED</option></select></td></tr>`).join("") || '<tr><td colspan="6" class="empty-state">No incidents created.</td></tr>';
    $$("#incidents-table tr[data-incident]").forEach((row) => row.addEventListener("click", (event) => {
      if (event.target.matches("select, option")) return;
      const incident = state.incidents.find((item) => item.incident_id === row.dataset.incident);
      if (!incident) return;
      $("#incident-detail").innerHTML = `<div class="panel-heading"><div><p class="eyebrow">SELECTED CASE</p><h3>${escapeHtml(incident.incident_id)}</h3></div><span class="status-badge">${escapeHtml(incident.status)}</span></div><div class="incident-detail-grid"><div><span>ANALYSIS ID</span><b>${escapeHtml(incident.analysis_id || "—")}</b></div><div><span>CREATED</span><b>${escapeHtml(formatTime(incident.timestamp))}</b></div><div><span>SEVERITY</span><b>${escapeHtml(incident.risk_level || "—")}</b></div><div><span>DECISION</span><b>${escapeHtml(incident.recommended_action || "—")}</b></div><div><span>VOICE SCORE</span><b>${Number(incident.voice_score || 0).toFixed(1)}/100</b></div><div><span>SECURITY RISK</span><b>${Number(incident.security_risk || 0).toFixed(1)}/100</b></div></div><p class="muted incident-reason">${escapeHtml(incident.reason || "No reason recorded.")}</p>`;
      $("#incident-detail").classList.remove("hidden");
      $("#incident-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
    $$(".incident-status").forEach((select) => select.addEventListener("change", async () => {
      await api(`/api/incidents/${select.dataset.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: select.value }) });
      await loadIncidents();
      await loadEvents();
    }));
  } catch (error) { console.warn("Could not load incidents", error); }
}

async function loadAudit() {
  try {
    const data = await api("/api/audit");
    $("#audit-count").textContent = `${data.events.length} record${data.events.length === 1 ? "" : "s"}`;
    $("#audit-table").innerHTML = data.events.map((event) => `<tr><td>${formatTime(event.timestamp)}</td><td>${escapeHtml(event.event_type)}</td><td>${escapeHtml(event.event_id.slice(0, 16))}</td><td><span class="mono hash-value">${escapeHtml((event.event_hash || "").slice(0, 12)) || "—"}</span></td><td><span class="mono hash-value">${escapeHtml((event.previous_hash || "").slice(0, 12)) || "—"}</span></td><td>${escapeHtml(JSON.stringify(event.details || {}).slice(0, 70))}</td></tr>`).join("") || '<tr><td colspan="6" class="empty-state">No audit events yet.</td></tr>';
  } catch (error) { console.warn("Could not load audit", error); }
}
$("#verify-audit").addEventListener("click", async () => {
  const result = await api("/api/audit/verify");
  const banner = $("#audit-verification");
  banner.textContent = `${result.valid ? "✓ " : "⚠ "}${result.message} Checked ${result.checked} record${result.checked === 1 ? "" : "s"}.`;
  banner.classList.remove("hidden");
});

async function loadPrivacy() {
  try {
    const data = await api("/api/privacy");
    $("#privacy-retention").textContent = data.retention_setting === "delete_after_analysis" ? "DELETE AFTER ANALYSIS" : data.retention_setting;
    $("#privacy-audit-status").textContent = data.audit_chain_valid ? "CHAIN VALID" : "CHECK REQUIRED";
  } catch (error) { $("#privacy-audit-status").textContent = "UNAVAILABLE"; }
}

function evaluationMetric(value) {
  return value === null || value === undefined ? "—" : `${(finiteNumber(value, "evaluation metric") * 100).toFixed(1)}%`;
}

function renderEvaluation(evaluation) {
  const configured = Boolean(evaluation.configured);
  const evaluated = Number(evaluation.evaluated_count || 0);
  $("#evaluation-title").textContent = !configured ? "EVALUATION DATASET NOT CONFIGURED" : evaluated ? "EVALUATION DATASET PROCESSED" : "EVALUATION DATASET NEEDS ATTENTION";
  $("#evaluation-message").textContent = evaluation.message;
  $("#evaluation-count").textContent = `${evaluated} evaluated · ${Number(evaluation.skipped_count || 0)} skipped`;
  const metrics = evaluation.metrics;
  $("#evaluation-metrics").innerHTML = metrics ? [
    ["Accuracy", metrics.accuracy],
    ["Precision", metrics.precision],
    ["Recall", metrics.recall],
    ["F1 score", metrics.f1],
    ["ROC-AUC", metrics.roc_auc],
  ].map(([label, value]) => `<div class="metric-tile"><span>${label}</span><b>${evaluationMetric(value)}</b></div>`).join("") :
    '<div class="empty-state">Evaluation metrics will appear after a labeled dataset is configured.</div>';
  const matrix = evaluation.confusion_matrix || {};
  [["true_positive", "TRUE POSITIVE"], ["true_negative", "TRUE NEGATIVE"], ["false_positive", "FALSE POSITIVE"], ["false_negative", "FALSE NEGATIVE"]].forEach(([key, label]) => {
    const tile = $(`#evaluation-matrix div:nth-child(${["true_positive", "true_negative", "false_positive", "false_negative"].indexOf(key) + 1})`);
    tile.querySelector("span").textContent = label;
    tile.querySelector("b").textContent = configured ? String(matrix[key] ?? 0) : "—";
  });
  const errors = (evaluation.errors || []).map((error) => escapeHtml(error)).join("<br>");
  $("#evaluation-errors").innerHTML = errors;
  $("#evaluation-errors").classList.toggle("hidden", !errors);
}

async function loadEvaluation() {
  try {
    const data = await api("/api/evaluation");
    renderEvaluation(data.evaluation || {});
  } catch (error) {
    $("#evaluation-title").textContent = "Evaluation unavailable";
    $("#evaluation-message").textContent = error.message;
  }
}

$("#refresh-evaluation").addEventListener("click", loadEvaluation);

async function loadSettings() {
  try {
    const data = await api("/api/settings");
    const form = $("#settings-form");
    Object.entries(data.settings).forEach(([key, value]) => {
      const field = form.elements[key];
      if (field && field.type === "checkbox") field.checked = Boolean(value);
      else if (field) field.value = value;
    });
  } catch (error) { console.warn("Could not load settings", error); }
}
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {};
  ["medium_threshold", "high_threshold", "escalation_threshold"].forEach((key) => payload[key] = Number(form.elements[key].value));
  payload.verification_required = form.elements.verification_required.checked;
  payload.anonymized_logging = form.elements.anonymized_logging.checked;
  try {
    await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    $("#settings-saved").textContent = "Saved ✓";
    setTimeout(() => { $("#settings-saved").textContent = ""; }, 2500);
  } catch (error) { $("#settings-saved").textContent = error.message; }
});

async function analyzeLiveChunk(blob, sequence) {
  if (state.liveBusy) return;
  state.liveBusy = true;
  const body = new FormData();
  body.append("audio", blob, `live-chunk-${sequence}.webm`);
  body.append("source_type", "near_real_time_prototype");
  try {
    const data = await api("/predict", { method: "POST", body });
    const result = data.result;
    const score = finiteNumber(result?.security?.security_risk_score, "live security risk score");
    $("#live-score").textContent = `${score.toFixed(1)}%`;
    $("#live-fill").style.width = `${score}%`;
    $("#live-events").insertAdjacentHTML("afterbegin", `<div class="live-event"><span>Chunk ${sequence} · ${result.security.risk_level}</span><b>${score.toFixed(1)}% security risk</b></div>`);
    $$(".live-timeline span").forEach((bar, index) => { bar.style.height = `${18 + ((score + index * 13) % 65)}%`; });
  } catch (error) {
    $("#live-substatus").textContent = error.message;
  } finally { state.liveBusy = false; }
}

$("#live-start").addEventListener("click", async () => {
  try {
    state.liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.mediaRecorder = new MediaRecorder(state.liveStream);
    let sequence = 0;
    state.mediaRecorder.addEventListener("dataavailable", (event) => { if (event.data.size) analyzeLiveChunk(event.data, ++sequence); });
    state.mediaRecorder.start(3500);
    $("#live-start").classList.add("hidden"); $("#live-stop").classList.remove("hidden");
    $("#live-badge").textContent = "CAPTURING"; $("#live-badge").style.color = "var(--teal)";
    $("#live-status").textContent = "Listening for analysis chunks"; $("#live-substatus").textContent = "Every chunk follows the real upload pipeline.";
  } catch (error) { $("#live-substatus").textContent = `Microphone unavailable: ${error.message}`; }
});
$("#live-stop").addEventListener("click", () => {
  state.mediaRecorder?.stop(); state.liveStream?.getTracks().forEach((track) => track.stop());
  $("#live-start").classList.remove("hidden"); $("#live-stop").classList.add("hidden");
  $("#live-badge").textContent = "IDLE"; $("#live-badge").style.color = "var(--muted)";
  $("#live-status").textContent = "Capture stopped"; $("#live-substatus").textContent = "Start again to analyze new chunks.";
});

$$("[data-action='refresh']").forEach((button) => button.addEventListener("click", async () => { await loadHealth(); await loadEvents(); await loadIncidents(); }));
const initialView = location.hash.replace("#", "");
setView(pageMeta[initialView] ? initialView : "dashboard");
loadHealth(); loadEvents(); loadIncidents();