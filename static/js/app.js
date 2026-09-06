const form = document.querySelector("#analysis-form");
const fileInput = document.querySelector("#audio-file");
const dropZone = document.querySelector("#drop-zone");
const analyzeButton = document.querySelector("#analyze-button");
const selectedFile = document.querySelector("#selected-file");
const clearFile = document.querySelector("#clear-file");
const errorPanel = document.querySelector("#error-panel");
const results = document.querySelector("#results");

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showError(message) {
  errorPanel.textContent = message;
  errorPanel.classList.remove("hidden");
}

function clearError() {
  errorPanel.classList.add("hidden");
  errorPanel.textContent = "";
}

function setFile(file) {
  if (!file) return;
  fileInput.files = (() => {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    return transfer.files;
  })();
  document.querySelector("#selected-name").textContent = file.name;
  document.querySelector("#selected-meta").textContent = `${formatBytes(file.size)} · Ready for analysis`;
  document.querySelector("#drop-title").textContent = "Recording selected";
  document.querySelector("#drop-subtitle").textContent = "Choose another file or analyze this recording";
  selectedFile.classList.remove("hidden");
  analyzeButton.disabled = false;
  clearError();
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
clearFile.addEventListener("click", () => {
  fileInput.value = "";
  selectedFile.classList.add("hidden");
  analyzeButton.disabled = true;
  document.querySelector("#drop-title").textContent = "Choose an audio file";
  document.querySelector("#drop-subtitle").textContent = "Drag and drop or browse from your device";
});

function setLoading(loading) {
  analyzeButton.disabled = loading || !fileInput.files.length;
  analyzeButton.querySelector(".button-label").classList.toggle("hidden", loading);
  analyzeButton.querySelector(".button-loading").classList.toggle("hidden", !loading);
}

function renderResult(data) {
  const ensemble = Number(data.ensemble_score);
  const percent = Math.round(ensemble * 100);
  document.querySelector("#ensemble-score").textContent = percent;
  document.querySelector("#v2-score").textContent = `${Math.round(data.v2_prediction * 100)}%`;
  document.querySelector("#v4-score").textContent = `${Math.round(data.v4_prediction * 100)}%`;
  document.querySelector("#result-filename").textContent = data.filename;
  document.querySelector("#result-duration").textContent = `${data.duration_seconds}s`;
  document.querySelector("#result-time").textContent = `${data.processing_time_ms}ms`;
  document.querySelector("#score-meter-fill").style.width = `${percent}%`;
  document.querySelector("#risk-label").textContent = data.risk_level;
  document.querySelector("#risk-description").textContent = `${data.risk_level} application risk classification · not model accuracy`;
  document.querySelector("#model-statement").textContent = data.model_statement;
  const pill = document.querySelector("#risk-pill");
  const color = data.risk_level === "HIGH" ? "var(--red)" : data.risk_level === "MEDIUM" ? "var(--orange)" : "var(--cyan)";
  pill.style.color = color;
  document.querySelector("#score-meter-fill").style.background = color;
  results.classList.remove("hidden");
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!fileInput.files[0]) return;
  clearError();
  results.classList.add("hidden");
  setLoading(true);
  const body = new FormData();
  body.append("audio", fileInput.files[0]);
  try {
    const response = await fetch("/predict", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The analysis could not be completed.");
    renderResult(data);
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
});

async function loadHealth() {
  try {
    const response = await fetch("/health");
    const health = await response.json();
    ["v2", "v4"].forEach((version) => {
      const state = document.querySelector(`[data-model="${version}"]`);
      state.classList.toggle("loaded", health.models[version].loaded);
      state.textContent = health.models[version].loaded ? "●" : "○";
    });
    const ready = health.models.v2.loaded && health.models.v4.loaded;
    document.querySelector("#system-status").textContent = ready ? "Both models ready for inference" : "Model files required before inference";
  } catch (_error) {
    document.querySelector("#system-status").textContent = "Health status unavailable";
  }
}
loadHealth();