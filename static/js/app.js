const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  health: null,
  result: null,
  incidents: [],
  events: [],
  evaluation: null,
  evaluationSamples: [],
  mediaRecorder: null,
  liveStream: null,
  liveBusy: false,
};

const pageMeta = {
  dashboard: ["OVERVIEW", "Command center"],
  analysis: ["VOICE INTEGRITY", "Analyze a recording"],
  transaction: ["SECURITY OPERATIONS", "Transaction protection"],
  live: ["PROTOTYPE MODE", "Near-real-time analysis"],
  incidents: ["CASE MANAGEMENT", "Incident center"],
  audit: ["GOVERNANCE", "Audit trail"],
  privacy: ["GOVERNANCE", "Privacy center"],
  settings: ["GOVERNANCE", "Settings"],
  evaluation: ["MODEL VALIDATION", "Detection evaluation"],
};

const TIMEZONE = "Asia/Kolkata";

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[character])
  );
}

function getFormattedDashboardDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    month: "long",
    day: "2-digit",
    year: "numeric",
  }).formatToParts(date);

  const get = (type) =>
    parts.find((p) => p.type === type)?.value || "";

  const weekday = get("weekday").toUpperCase();
  const month = get("month").toUpperCase();
  const day = get("day");
  const year = get("year");

  return `${weekday} · ${month} ${day}, ${year}`;
}

function getFormattedCurrentTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}

function getGreeting(date = new Date()) {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      hour: "numeric",
      hourCycle: "h23",
    }).format(date),
    10
  );

  if (hour >= 5 && hour < 12) {
    return "Good morning,";
  } else if (hour >= 12 && hour < 17) {
    return "Good afternoon,";
  } else {
    return "Good evening,";
  }
}

function updateDashboardDateTime() {
  const dateEl =
    $("#dashboard-date") ||
    $(".welcome-row .eyebrow");

  if (dateEl) {
    dateEl.textContent =
      getFormattedDashboardDate();
  }

  const greetingEl =
    $("#dashboard-greeting") ||
    $(".welcome-row h2");

  if (greetingEl) {
    const greetingText =
      getGreeting();

    greetingEl.innerHTML =
      `${greetingText} <span>analyst.</span>`;
  }

  const clockEls = $$(
    ".current-time, #current-time, #dashboard-clock"
  );

  if (clockEls.length > 0) {
    const timeStr =
      getFormattedCurrentTime();

    clockEls.forEach(
      (el) => {
        el.textContent = timeStr;
      }
    );
  }
}

function formatTime(value) {
  if (!value) return "—";

  return new Date(value).toLocaleString(
    "en-US",
    {
      timeZone: TIMEZONE,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }
  );
}

function setView(view) {
  const meta =
    pageMeta[view] ||
    pageMeta.dashboard;

  $$(".view").forEach((section) => {
    section.classList.toggle(
      "active",
      section.id === `view-${view}`
    );
  });

  $$(".nav-item").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.nav === view
    );
  });

  $("#page-kicker").textContent =
    meta[0];

  $("#page-title").textContent =
    meta[1];

  history.replaceState(
    {},
    "",
    `#${view}`
  );

  if (view === "incidents") {
    loadIncidents();
  }

  if (view === "audit") {
    loadAudit();
  }

  if (view === "privacy") {
    loadPrivacy();
  }

  if (view === "settings") {
    loadSettings();
  }

  if (view === "evaluation") {
    loadEvaluation();
  }
}

$$("[data-nav]").forEach(
  (button) =>
    button.addEventListener(
      "click",
      (event) => {
        event.preventDefault();

        setView(
          button.dataset.nav
        );
      }
    )
);

async function api(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      options
    );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error ||
        `Request failed (${response.status})`
    );
  }

  return data;
}

function statusText(loaded) {
  return loaded
    ? "LOADED"
    : "MISSING";
}

async function loadHealth() {
  try {
    state.health =
      await api("/health");

    const {
      models,
      tensorflow_available:
        tensorflow,
    } = state.health;

    const ready =
      models.v2.loaded &&
      models.v4.loaded;

    $("#header-health").textContent =
      ready
        ? "All systems operational"
        : "Models require attention";

    $("#dash-v2").textContent =
      statusText(
        models.v2.loaded
      );

    $("#dash-v4").textContent =
      statusText(
        models.v4.loaded
      );

    $("#dash-v2").className =
      `health-state ${
        models.v2.loaded
          ? "good"
          : "orange"
      }`;

    $("#dash-v4").className =
      `health-state ${
        models.v4.loaded
          ? "good"
          : "orange"
      }`;

    $("#model-stack-status").textContent =
      ready
        ? "READY"
        : "ACTION REQUIRED";

    $("#settings-tf").textContent =
      tensorflow
        ? "AVAILABLE"
        : "MISSING";

    $("#settings-v2").textContent =
      statusText(
        models.v2.loaded
      );

    $("#settings-v4").textContent =
      statusText(
        models.v4.loaded
      );
  } catch (error) {
    $("#header-health").textContent =
      "Health check unavailable";
  }
}

function renderDashboard() {
  const events =
    state.events.filter(
      (event) =>
        event.event_type ===
        "ANALYSIS_PERFORMED"
    );

  const high =
    events.filter(
      (event) =>
        (event.details
          ?.security_risk_score ||
          0) >= 75
    );

  $("#dash-analyses").textContent =
    events.length;

  $("#dash-high").textContent =
    high.length;

  $("#dash-threat").textContent =
    high.length
      ? "ELEVATED"
      : "CLEAR";

  $("#dash-threat-note").textContent =
    high.length
      ? `${high.length} high-risk event${
          high.length === 1
            ? ""
            : "s"
        } in the audit stream`
      : "No active high-risk events";

  $("#dash-integrity").textContent =
    state.auditValid === false
      ? "CHECK"
      : "VALID";

  $("#dash-integrity").className =
    `big-number ${
      state.auditValid === false
        ? "orange"
        : "teal"
    }`;

  $("#dash-integrity-note").textContent =
    state.auditChecked
      ? `${state.auditChecked} chained record${
          state.auditChecked === 1
            ? ""
            : "s"
        } verified`
      : "Hash chain status";

  const rows =
    events
      .slice(0, 6)
      .map((event) => {
        const detail =
          event.details || {};

        const risk =
          Number(
            detail.security_risk_score ||
              0
          );

        return `
          <tr>
            <td>
              ${escapeHtml(
                detail.analysis_id ||
                  event.event_id.slice(
                    0,
                    12
                  )
              )}
            </td>
            <td>
              ${formatTime(
                event.timestamp
              )}
            </td>
            <td>
              ${Number(
                detail.model_score || 0
              ).toFixed(1)}%
            </td>
            <td>
              ${risk.toFixed(1)}%
            </td>
            <td>
              <span class="table-status ${
                risk >= 75
                  ? "high"
                  : risk >= 40
                  ? "medium"
                  : "low"
              }">
                ${
                  risk >= 75
                    ? "HIGH"
                    : risk >= 40
                    ? "MEDIUM"
                    : "LOW"
                }
              </span>
            </td>
          </tr>
        `;
      })
      .join("");

  $("#recent-analyses").innerHTML =
    rows ||
    '<tr><td colspan="5" class="empty-state">No analyses recorded yet. Start with an audio recording.</td></tr>';
}

async function loadEvents() {
  try {
    const data =
      await api("/api/events");

    state.events =
      data.events || [];

    const verification =
      await api(
        "/api/audit/verify"
      );

    state.auditValid =
      verification.valid;

    state.auditChecked =
      verification.checked;

    renderDashboard();
  } catch (error) {
    console.warn(
      "Could not load events",
      error
    );
  }
}

function formatBytes(bytes) {
  return bytes <
    1024 * 1024
    ? `${Math.max(
        1,
        Math.round(
          bytes / 1024
        )
      )} KB`
    : `${(
        bytes /
        1024 /
        1024
      ).toFixed(1)} MB`;
}

const fileInput =
  $("#audio-file");

const dropZone =
  $("#drop-zone");

function setFile(file) {
  if (!file) return;

  const transfer =
    new DataTransfer();

  transfer.items.add(file);

  fileInput.files =
    transfer.files;

  $("#selected-name").textContent =
    file.name;

  $("#selected-meta").textContent =
    `${formatBytes(
      file.size
    )} · ready for analysis`;

  $("#drop-title").textContent =
    "Recording selected";

  $("#drop-subtitle").textContent =
    "Choose another file or run the analysis";

  $("#selected-file")
    .classList.remove(
      "hidden"
    );

  $("#analyze-button")
    .disabled = false;

  $("#error-panel")
    .classList.add(
      "hidden"
    );
}

fileInput.addEventListener(
  "change",
  () =>
    setFile(
      fileInput.files[0]
    )
);

["dragenter", "dragover"]
  .forEach(
    (eventName) =>
      dropZone.addEventListener(
        eventName,
        (event) => {
          event.preventDefault();

          dropZone.classList.add(
            "dragging"
          );
        }
      )
  );

["dragleave", "drop"]
  .forEach(
    (eventName) =>
      dropZone.addEventListener(
        eventName,
        (event) => {
          event.preventDefault();

          dropZone.classList.remove(
            "dragging"
          );
        }
      )
  );

dropZone.addEventListener(
  "drop",
  (event) =>
    setFile(
      event.dataTransfer.files[0]
    )
);

$("#clear-file")
  .addEventListener(
    "click",
    () => {
      fileInput.value =
        "";

      $("#selected-file")
        .classList.add(
          "hidden"
        );

      $("#analyze-button")
        .disabled = true;

      $("#drop-title").textContent =
        "Drop an audio file here";

      $("#drop-subtitle").textContent =
        "or browse from your device";
    }
  );

function setLoading(
  loading
) {
  $("#analyze-button")
    .disabled =
    loading ||
    !fileInput.files.length;

  $(".button-label", $("#analyze-button"))
    .classList.toggle(
      "hidden",
      loading
    );

  $(".button-loading", $("#analyze-button"))
    .classList.toggle(
      "hidden",
      !loading
    );
}

function showError(
  message
) {
  $("#error-panel")
    .textContent =
    message;

  $("#error-panel")
    .classList.remove(
      "hidden"
    );
}

function finiteNumber(
  value,
  fieldName
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    throw new Error(
      `Analysis response contains an invalid ${fieldName}.`
    );
  }

  return number;
}

function renderTimeline(
  items
) {
  $("#timeline").innerHTML =
    (items || [])
      .map((item) => {
        const start =
          finiteNumber(
            item.start_seconds,
            "timeline start"
          );

        const end =
          finiteNumber(
            item.end_seconds,
            "timeline end"
          );

        const ensemble =
          finiteNumber(
            item.ensemble_score,
            "timeline ensemble score"
          );

        return `
          <div class="timeline-item ${
            item.status === "HIGH"
              ? "high"
              : ""
          }">
            <b>
              ${escapeHtml(
                item.status
              )}
            </b>
            <small>
              ${start}s–${end}s
              <br>
              ${ensemble.toFixed(
                1
              )}% model
            </small>
          </div>
        `;
      })
      .join("") ||
    '<div class="empty-state">No timeline segments.</div>';
}

function renderResult(
  result
) {
  if (
    !result ||
    !result.security
  ) {
    throw new Error(
      "Analysis response is missing the result payload."
    );
  }

  state.result =
    result;

  const model =
    finiteNumber(
      result.model_score,
      "ensemble score"
    );

  const security =
    finiteNumber(
      result.security
        .security_risk_score,
      "security risk score"
    );

  const v2 =
    finiteNumber(
      result.v2_score,
      "V2 prediction"
    );

  const v4 =
    finiteNumber(
      result.v4_score,
      "V4 prediction"
    );

  const duration =
    finiteNumber(
      result.duration_seconds,
      "duration"
    );

  const processing =
    finiteNumber(
      result.processing_time_ms,
      "processing time"
    );

  const risk =
    result.security.risk_level;

  $("#result-file-title").textContent =
    result.filename;

  $("#result-id").textContent =
    result.analysis_id;

  $("#ensemble-score").textContent =
    model.toFixed(1);

  $("#security-score").textContent =
    security.toFixed(1);

  $("#v2-score").textContent =
    `${v2.toFixed(1)}%`;

  $("#v4-score").textContent =
    `${v4.toFixed(1)}%`;

  $("#result-time").textContent =
    `${processing.toFixed(2)}ms`;

  $("#result-filename").textContent =
    result.filename;

  $("#result-duration").textContent =
    `${duration.toFixed(2)}s`;

  $("#score-fill").style.width =
    `${Math.max(
      0,
      Math.min(
        100,
        model
      )
    )}%`;

  $("#security-fill").style.width =
    `${Math.max(
      0,
      Math.min(
        100,
        security
      )
    )}%`;

  $("#risk-label").textContent =
    risk;

  const riskColor =
    risk === "HIGH"
      ? "var(--red)"
      : risk === "MEDIUM"
      ? "var(--orange)"
      : "var(--teal)";

  $("#risk-pill").style.color =
    riskColor;

  $("#recommended-action").textContent =
    result.security
      .recommended_action;

  $("#recommendation").textContent =
    result.security
      .recommendation;

  $("#classification-label").textContent =
    result.classification ||
    "—";

  $("#classification-label").style.color =
    result.classification ===
    "FAKE"
      ? "var(--red)"
      : "var(--teal)";

  $("#classification-reason").textContent =
    result.classification_reason ||
    "No classification explanation returned.";

  $("#alert-email").textContent =
    result.alert_status?.email ||
    "NOT REQUIRED";

  $("#alert-sms").textContent =
    result.alert_status?.sms ||
    "NOT REQUIRED";

  const context =
    result.context || {};

  const signals =
    Array.isArray(
      context.social_signals
    )
      ? context.social_signals
      : [];

  const modelEvidence = [
    `V2 deepfake score: ${v2.toFixed(
      1
    )}/100`,
    `V4 deepfake score: ${v4.toFixed(
      1
    )}/100`,
    `Ensemble model score: ${model.toFixed(
      1
    )}/100`,
  ];

  const contextEvidence = [
    `Caller: ${
      context.caller_type ===
      "UNKNOWN"
        ? "Unknown"
        : "Known"
    }`,

    `Interaction: ${
      context.first_time_caller
        ? "First-time caller"
        : "Previous interaction"
    }`,

    `Request: ${
      context.sensitive_request
        ? "Sensitive request"
        : "Normal request"
    }${
      context.requested_action &&
      context.requested_action !==
        "OTHER"
        ? ` (${context.requested_action})`
        : ""
    }`,

    `Transaction: ${
      context.high_value_transaction
        ? "High-value transaction"
        : "Normal value"
    }`,

    `History: ${
      context.previous_high_risk
        ? "Previous high-risk interaction"
        : "No previous high-risk interaction"
    }`,
  ];

  const socialLabels = {
    urgent_payment:
      "Urgent payment request",

    credential_request:
      "Credential request",

    secrecy_request:
      "Secrecy / pressure",

    authority_claim:
      "Authority claim",

    bypass_verification:
      "Verification bypass",

    change_payment_details:
      "Payment-detail change",
  };

  const socialEvidence =
    signals
      .map(
        (signal) =>
          socialLabels[signal] ||
          signal
      )
      .filter(Boolean);

  const renderEvidence =
    (
      selector,
      items,
      emptyText
    ) => {
      $(selector).innerHTML =
        (
          items.length
            ? items
            : [emptyText]
        )
          .map(
            (item) =>
              `<li>${escapeHtml(
                item
              )}</li>`
          )
          .join("");
    };

  renderEvidence(
    "#model-evidence",
    modelEvidence,
    "No model evidence available."
  );

  renderEvidence(
    "#context-evidence",
    contextEvidence,
    "No context signals selected."
  );

  renderEvidence(
    "#social-evidence",
    socialEvidence,
    "No social-engineering indicators selected."
  );

  $("#model-statement").textContent =
    result.model_statement;

  renderTimeline(
    result.timeline
  );

    $("#result-panel")
    .classList.remove(
      "hidden"
    );

  renderEvaluationAction();

  $("#result-panel")
    .scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
}

function formContext() {
  const form =
    $("#analysis-form");

  const values = {};

  [
    "caller_type",
    "requested_action",
    "first_time_caller",
    "sensitive_request",
    "high_value_transaction",
    "previous_high_risk",
  ].forEach((name) => {
    const input =
      form.elements[name];

    values[name] =
      input.type ===
      "checkbox"
        ? input.checked
        : input.value;
  });

  values.social_signals =
    $$(".signal-chip input:checked")
      .map(
        (input) =>
          input.value
      );

  return values;
}

$("#analysis-form")
  .addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      clearError();

      $("#result-panel")
        .classList.add(
          "hidden"
        );

      setLoading(true);

      const body =
        new FormData();

      body.append(
        "audio",
        fileInput.files[0]
      );

      const context =
        formContext();

      Object.entries(
        context
      ).forEach(
        ([key, value]) =>
          body.append(
            key,
            Array.isArray(
              value
            )
              ? JSON.stringify(
                  value
                )
              : value
          )
      );

      try {
        const data =
          await api(
            "/predict",
            {
              method: "POST",
              body,
            }
          );

        if (!data.result) {
          throw new Error(
            "Analysis response did not include a result payload."
          );
        }

        renderResult(
          data.result
        );

        await loadEvents();
      } catch (error) {
        showError(
          error.message
        );
      } finally {
        setLoading(false);
      }
    }
  );

function clearError() {
  $("#error-panel")
    .classList.add(
      "hidden"
    );

  $("#error-panel")
    .textContent = "";
}

$("#create-incident")
  .addEventListener(
    "click",
    async () => {
      if (!state.result)
        return;

      try {
        const result =
          state.result;

        await api(
          "/api/incidents",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify(
              {
                analysis_id:
                  result.analysis_id,

                risk_level:
                  result.security
                    .risk_level,

                voice_score:
                  result.model_score,

                security_risk:
                  result.security
                    .security_risk_score,

                recommended_action:
                  result.security
                    .recommended_action,

                reason:
                  result.security
                    .reasons.join(
                      " · "
                    ),
              }
            ),
          }
        );

        $("#create-incident")
          .textContent =
          "Incident created ✓";

        await loadIncidents();
        await loadEvents();
      } catch (error) {
        showError(
          error.message
        );
      }
    }
  );

$$("[data-action='security']")
  .forEach(
    (button) =>
      button.addEventListener(
        "click",
        async () => {
          if (!state.result)
            return;

          try {
            await api(
              "/api/security-action",
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/json",
                },
                body: JSON.stringify(
                  {
                    action:
                      button.dataset
                        .value,

                    analysis_id:
                      state.result
                        .analysis_id,

                    risk_level:
                      state.result
                        .security
                        .risk_level,
                  }
                ),
              }
            );

            button.textContent =
              `${button.textContent} ✓`;

            await loadEvents();
          } catch (error) {
            showError(
              error.message
            );
          }
        }
      )
  );

$("#print-report")
  .addEventListener(
    "click",
    () =>
      window.print()
  );

async function loadIncidents() {
  try {
    const data =
      await api(
        "/api/incidents"
      );

    state.incidents =
      data.incidents || [];

    const open =
      state.incidents.filter(
        (incident) =>
          incident.status !==
          "RESOLVED"
      ).length;

    $("#incident-count")
      .textContent =
      `${open} OPEN`;

    $("#incidents-table")
      .innerHTML =
      state.incidents
        .map(
          (incident) =>
            `
            <tr data-incident="${escapeHtml(
              incident.incident_id
            )}">
              <td>
                ${escapeHtml(
                  incident.incident_id
                )}
              </td>

              <td>
                ${formatTime(
                  incident.timestamp
                )}
              </td>

              <td>
                <span class="table-status high">
                  ${escapeHtml(
                    incident.risk_level
                  )}
                </span>
              </td>

              <td>
                ${Number(
                  incident.voice_score ||
                    0
                ).toFixed(
                  1
                )}%
                /
                ${Number(
                  incident.security_risk ||
                    0
                ).toFixed(
                  1
                )}%
              </td>

              <td>
                ${escapeHtml(
                  incident.recommended_action
                )}
              </td>

              <td>
                <select
                  class="incident-status"
                  data-id="${escapeHtml(
                    incident.incident_id
                  )}"
                >
                  <option ${
                    incident.status ===
                    "OPEN"
                      ? "selected"
                      : ""
                  }>
                    OPEN
                  </option>

                  <option ${
                    incident.status ===
                    "INVESTIGATING"
                      ? "selected"
                      : ""
                  }>
                    INVESTIGATING
                  </option>

                  <option ${
                    incident.status ===
                    "RESOLVED"
                      ? "selected"
                      : ""
                  }>
                    RESOLVED
                  </option>
                </select>
              </td>
            </tr>
          `
        )
        .join("") ||
      '<tr><td colspan="6" class="empty-state">No incidents created.</td></tr>';

    $$("#incidents-table tr[data-incident]")
      .forEach(
        (row) =>
          row.addEventListener(
            "click",
            (event) => {
              if (
                event.target.matches(
                  "select, option"
                )
              ) {
                return;
              }

              const incident =
                state.incidents.find(
                  (item) =>
                    item.incident_id ===
                    row.dataset
                      .incident
                );

              if (!incident)
                return;

              $("#incident-detail")
                .innerHTML = `
                  <div class="panel-heading">
                    <div>
                      <p class="eyebrow">
                        SELECTED CASE
                      </p>

                      <h3>
                        ${escapeHtml(
                          incident.incident_id
                        )}
                      </h3>
                    </div>

                    <span class="status-badge">
                      ${escapeHtml(
                        incident.status
                      )}
                    </span>
                  </div>

                  <div class="incident-detail-grid">
                    <div>
                      <span>
                        ANALYSIS ID
                      </span>
                      <b>
                        ${escapeHtml(
                          incident.analysis_id ||
                            "—"
                        )}
                      </b>
                    </div>

                    <div>
                      <span>
                        CREATED
                      </span>
                      <b>
                        ${escapeHtml(
                          formatTime(
                            incident.timestamp
                          )
                        )}
                      </b>
                    </div>

                    <div>
                      <span>
                        SEVERITY
                      </span>
                      <b>
                        ${escapeHtml(
                          incident.risk_level ||
                            "—"
                        )}
                      </b>
                    </div>

                    <div>
                      <span>
                        DECISION
                      </span>
                      <b>
                        ${escapeHtml(
                          incident.recommended_action ||
                            "—"
                        )}
                      </b>
                    </div>

                    <div>
                      <span>
                        VOICE SCORE
                      </span>
                      <b>
                        ${Number(
                          incident.voice_score ||
                            0
                        ).toFixed(
                          1
                        )}/100
                      </b>
                    </div>

                    <div>
                      <span>
                        SECURITY RISK
                      </span>
                      <b>
                        ${Number(
                          incident.security_risk ||
                            0
                        ).toFixed(
                          1
                        )}/100
                      </b>
                    </div>
                  </div>

                  <p class="muted incident-reason">
                    ${escapeHtml(
                      incident.reason ||
                        "No reason recorded."
                    )}
                  </p>
                `;

              $("#incident-detail")
                .classList.remove(
                  "hidden"
                );

              $("#incident-detail")
                .scrollIntoView({
                  behavior:
                    "smooth",
                  block:
                    "nearest",
                });
            }
          )
      );

    $$(".incident-status")
      .forEach(
        (select) =>
          select.addEventListener(
            "change",
            async () => {
              try {
                await api(
                  `/api/incidents/${encodeURIComponent(
                    select.dataset
                      .id
                  )}`,
                  {
                    method:
                      "PATCH",
                    headers: {
                      "Content-Type":
                        "application/json",
                    },
                    body: JSON.stringify(
                      {
                        status:
                          select.value,
                      }
                    ),
                  }
                );

                await loadIncidents();
                await loadEvents();
              } catch (error) {
                showError(
                  error.message
                );
              }
            }
          )
      );
  } catch (error) {
    console.warn(
      "Could not load incidents",
      error
    );
  }
}

async function loadAudit() {
  try {
    const data =
      await api(
        "/api/audit"
      );

    $("#audit-count")
      .textContent =
      `${data.events.length} record${
        data.events.length ===
        1
          ? ""
          : "s"
      }`;

    $("#audit-table")
      .innerHTML =
      data.events
        .map(
          (event) =>
            `
            <tr>
              <td>
                ${formatTime(
                  event.timestamp
                )}
              </td>

              <td>
                ${escapeHtml(
                  event.event_type
                )}
              </td>

              <td>
                ${escapeHtml(
                  event.event_id.slice(
                    0,
                    16
                  )
                )}
              </td>

              <td>
                <span class="mono hash-value">
                  ${escapeHtml(
                    (
                      event.event_hash ||
                      ""
                    ).slice(
                      0,
                      12
                    )
                  ) || "—"}
                </span>
              </td>

              <td>
                <span class="mono hash-value">
                  ${escapeHtml(
                    (
                      event.previous_hash ||
                      ""
                    ).slice(
                      0,
                      12
                    )
                  ) || "—"}
                </span>
              </td>

              <td>
                ${escapeHtml(
                  JSON.stringify(
                    event.details ||
                      {}
                  ).slice(
                    0,
                    70
                  )
                )}
              </td>
            </tr>
          `
        )
        .join("") ||
      '<tr><td colspan="6" class="empty-state">No audit events yet.</td></tr>';
  } catch (error) {
    console.warn(
      "Could not load audit",
      error
    );
  }
}

$("#verify-audit")
  .addEventListener(
    "click",
    async () => {
      try {
        const result =
          await api(
            "/api/audit/verify"
          );

        const banner =
          $("#audit-verification");

        banner.textContent =
          `${
            result.valid
              ? "✓ "
              : "⚠ "
          }${result.message} Checked ${
            result.checked
          } record${
            result.checked ===
            1
              ? ""
              : "s"
          }.`;

        banner.classList.remove(
          "hidden"
        );
      } catch (error) {
        showError(
          error.message
        );
      }
    }
  );

async function loadPrivacy() {
  try {
    const data =
      await api(
        "/api/privacy"
      );

    $("#privacy-retention")
      .textContent =
      data.retention_setting ===
      "delete_after_analysis"
        ? "DELETE AFTER ANALYSIS"
        : data.retention_setting;

    $("#privacy-audit-status")
      .textContent =
      data.audit_chain_valid
        ? "CHAIN VALID"
        : "CHECK REQUIRED";
  } catch (error) {
    $("#privacy-audit-status")
      .textContent =
      "UNAVAILABLE";
  }
}

async function loadSettings() {
  try {
    const data =
      await api(
        "/api/settings"
      );

    const form =
      $("#settings-form");

    Object.entries(
      data.settings
    ).forEach(
      ([key, value]) => {
        const field =
          form.elements[key];

        if (
          field &&
          field.type ===
            "checkbox"
        ) {
          field.checked =
            Boolean(value);
        } else if (
          field
        ) {
          field.value =
            value;
        }
      }
    );
  } catch (error) {
    console.warn(
      "Could not load settings",
      error
    );
  }
}

$("#settings-form")
  .addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const form =
        event.currentTarget;

      const payload = {};

      [
        "medium_threshold",
        "high_threshold",
        "escalation_threshold",
      ].forEach(
        (key) => {
          payload[key] =
            Number(
              form.elements[
                key
              ].value
            );
        }
      );

      payload.verification_required =
        form.elements
          .verification_required
          .checked;

      payload.anonymized_logging =
        form.elements
          .anonymized_logging
          .checked;

      try {
        await api(
          "/api/settings",
          {
            method:
              "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify(
              payload
            ),
          }
        );

        $("#settings-saved")
          .textContent =
          "Saved ✓";

        setTimeout(
          () => {
            $("#settings-saved")
              .textContent =
              "";
          },
          2500
        );
      } catch (error) {
        $("#settings-saved")
          .textContent =
          error.message;
      }
    }
  );

/*
|--------------------------------------------------------------------------
| DETECTION EVALUATION FRONTEND
|--------------------------------------------------------------------------
*/

function formatMetric(
  value
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return "—";
  }

  return `${(
    Number(value) *
    100
  ).toFixed(1)}%`;
}

function formatCount(
  value
) {
  return Number(
    value || 0
  ).toString();
}

function renderEvaluation(
  payload
) {
  const evaluation =
    payload.evaluation ||
    {};

  const matrix =
    evaluation.confusion_matrix ||
    {};

  const realCount =
    evaluation
      .expected_label_counts
      ?.real || 0;

  const fakeCount =
    evaluation
      .expected_label_counts
      ?.fake || 0;

  $("#evaluation-sample-count")
    .textContent =
    evaluation.sample_count ??
    0;

  $("#evaluation-real-count")
    .textContent =
    realCount;

  $("#evaluation-fake-count")
    .textContent =
    fakeCount;

  $("#evaluation-accuracy")
    .textContent =
    formatMetric(
      evaluation.accuracy
    );

  $("#evaluation-precision")
    .textContent =
    formatMetric(
      evaluation.precision
    );

  $("#evaluation-recall")
    .textContent =
    formatMetric(
      evaluation.recall
    );

  $("#evaluation-f1")
    .textContent =
    formatMetric(
      evaluation.f1
    );

  $("#evaluation-fpr")
    .textContent =
    formatMetric(
      evaluation.false_positive_rate
    );

  $("#evaluation-fnr")
    .textContent =
    formatMetric(
      evaluation.false_negative_rate
    );

  $("#evaluation-tp")
    .textContent =
    formatCount(
      matrix.true_positive
    );

  $("#evaluation-tn")
    .textContent =
    formatCount(
      matrix.true_negative
    );

  $("#evaluation-fp")
    .textContent =
    formatCount(
      matrix.false_positive
    );

  $("#evaluation-fn")
    .textContent =
    formatCount(
      matrix.false_negative
    );

  $("#evaluation-threshold")
    .textContent =
    `${Number(
      evaluation.threshold ??
        50
    ).toFixed(
      0
    )}/100`;

  const status =
    evaluation.dataset_status ||
    "EMPTY";

  $("#evaluation-status")
    .textContent =
    status;

  $("#evaluation-status-note")
    .textContent =
    evaluation.evaluation_note ||
    "No evaluation data yet.";

  const warning =
    $("#evaluation-warning");

  if (
    evaluation.has_enough_data
  ) {
    warning.classList.add(
      "hidden"
    );
  } else {
    warning.classList.remove(
      "hidden"
    );

    warning.textContent =
      evaluation.evaluation_note ||
      "Add more labeled samples before making performance claims.";
  }

  state.evaluation =
    evaluation;

  state.evaluationSamples =
    payload.samples || [];

  renderEvaluationSamples(
    state.evaluationSamples
  );
}

function renderEvaluationSamples(
  samples
) {
  const table =
    $("#evaluation-samples");

  if (!table) return;

  if (
    !samples ||
    samples.length === 0
  ) {
    table.innerHTML =
      '<tr><td colspan="7" class="empty-state">No labeled evaluation samples yet.</td></tr>';

    return;
  }

  table.innerHTML =
    samples
      .slice()
      .reverse()
      .map(
        (sample) => `
          <tr>
            <td>
              ${escapeHtml(
                sample.evaluation_id
              )}
            </td>

            <td>
              ${formatTime(
                sample.timestamp
              )}
            </td>

            <td>
              <span class="table-status ${
                sample.expected_label ===
                "FAKE"
                  ? "high"
                  : "low"
              }">
                ${escapeHtml(
                  sample.expected_label
                )}
              </span>
            </td>

            <td>
              <span class="table-status ${
                sample.predicted_label ===
                "FAKE"
                  ? "high"
                  : "low"
              }">
                ${escapeHtml(
                  sample.predicted_label
                )}
              </span>
            </td>

            <td>
              ${
                sample.model_score ===
                  null ||
                sample.model_score ===
                  undefined
                  ? "—"
                  : `${Number(
                      sample.model_score
                    ).toFixed(
                      1
                    )}/100`
              }
            </td>

            <td>
              ${escapeHtml(
                sample.source ||
                  "manual"
              )}
            </td>

            <td>
              <button
                class="text-button evaluation-delete"
                data-id="${escapeHtml(
                  sample.evaluation_id
                )}"
                type="button"
              >
                Remove
              </button>
            </td>
          </tr>
        `
      )
      .join("");

  $$(".evaluation-delete")
    .forEach(
      (button) =>
        button.addEventListener(
          "click",
          async () => {
            const id =
              button.dataset.id;

            if (
              !confirm(
                "Remove this evaluation sample?"
              )
            ) {
              return;
            }

            try {
              await api(
                `/api/evaluation/sample/${encodeURIComponent(
                  id
                )}`,
                {
                  method:
                    "DELETE",
                }
              );

              await loadEvaluation();
            } catch (error) {
              showEvaluationMessage(
                error.message,
                true
              );
            }
          }
        )
    );
}

function showEvaluationMessage(
  message,
  isError = false
) {
  const element =
    $("#evaluation-message");

  if (!element)
    return;

  element.textContent =
    message;

  element.classList.remove(
    "hidden"
  );

  element.style.color =
    isError
      ? "var(--red)"
      : "var(--teal)";

  setTimeout(
    () => {
      element.classList.add(
        "hidden"
      );
    },
    3500
  );
}

async function loadEvaluation() {
  try {
    const data =
      await api(
        "/api/evaluation"
      );

    renderEvaluation(
      data
    );
  } catch (error) {
    showEvaluationMessage(
      `Could not load evaluation data: ${error.message}`,
      true
    );
  }
}

$("#evaluation-form")
  ?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const form =
        event.currentTarget;

      const expected =
        form.elements
          .expected_label.value;

      const predicted =
        form.elements
          .predicted_label.value;

      const modelScoreRaw =
        form.elements
          .model_score.value;

      const notes =
        form.elements
          .notes.value;

      const source =
        form.elements
          .source.value;

      const payload = {
        expected_label:
          expected,

        predicted_label:
          predicted,

        source:
          source || "manual",

        notes:
          notes || null,
      };

      if (
        modelScoreRaw !== ""
      ) {
        payload.model_score =
          Number(
            modelScoreRaw
          );
      }

      try {
        await api(
          "/api/evaluation/sample",
          {
            method:
              "POST",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify(
              payload
            ),
          }
        );

        form.reset();

        showEvaluationMessage(
          "Evaluation sample added."
        );

        await loadEvaluation();
      } catch (error) {
        showEvaluationMessage(
          error.message,
          true
        );
      }
    }
  );

$("#evaluation-reset")
  ?.addEventListener(
    "click",
    async () => {
      const samples =
        state.evaluation
          ?.sample_count || 0;

      if (
        samples > 0 &&
        !confirm(
          `Reset all ${samples} evaluation samples? This cannot be undone.`
        )
      ) {
        return;
      }

      try {
        await api(
          "/api/evaluation/reset",
          {
            method:
              "POST",
          }
        );

        showEvaluationMessage(
          "Evaluation dataset reset."
        );

        await loadEvaluation();
        await loadEvents();
      } catch (error) {
        showEvaluationMessage(
          error.message,
          true
        );
      }
    }
  );

$("#evaluation-refresh")
  ?.addEventListener(
    "click",
    async () => {
      await loadEvaluation();
    }
  );

async function analyzeLiveChunk(
  blob,
  sequence
) {
  if (
    state.liveBusy
  ) {
    return;
  }

  state.liveBusy =
    true;

  const body =
    new FormData();

  body.append(
    "audio",
    blob,
    `live-chunk-${sequence}.webm`
  );

  body.append(
    "source_type",
    "near_real_time_prototype"
  );

  try {
    const data =
      await api(
        "/predict",
        {
          method:
            "POST",
          body,
        }
      );

    const result =
      data.result;

    const score =
      finiteNumber(
        result?.security
          ?.security_risk_score,
        "live security risk score"
      );

    $("#live-score")
      .textContent =
      `${score.toFixed(
        1
      )}%`;

    $("#live-fill")
      .style.width =
      `${Math.max(
        0,
        Math.min(
          100,
          score
        )
      )}%`;

    $("#live-events")
      .insertAdjacentHTML(
        "afterbegin",
        `
          <div class="live-event">
            <span>
              Chunk ${sequence}
              · ${escapeHtml(
                result.security
                  .risk_level
              )}
            </span>

            <b>
              ${score.toFixed(
                1
              )}% security risk
            </b>
          </div>
        `
      );

    $$(".live-timeline span")
      .forEach(
        (bar, index) => {
          const height =
            18 +
            ((
              score +
              index * 13
            ) %
              65);

          bar.style.height =
            `${height}%`;
        }
      );
  } catch (error) {
    $("#live-substatus")
      .textContent =
      error.message;
  } finally {
    state.liveBusy =
      false;
  }
}

$("#live-start")
  .addEventListener(
    "click",
    async () => {
      try {
        state.liveStream =
          await navigator.mediaDevices.getUserMedia(
            {
              audio: true,
            }
          );

        state.mediaRecorder =
          new MediaRecorder(
            state.liveStream
          );

        let sequence = 0;

        state.mediaRecorder.addEventListener(
          "dataavailable",
          (event) => {
            if (
              event.data.size
            ) {
              analyzeLiveChunk(
                event.data,
                ++sequence
              );
            }
          }
        );

        state.mediaRecorder.start(
          3500
        );

        $("#live-start")
          .classList.add(
            "hidden"
          );

        $("#live-stop")
          .classList.remove(
            "hidden"
          );

        $("#live-badge")
          .textContent =
          "CAPTURING";

        $("#live-badge")
          .style.color =
          "var(--teal)";

        $("#live-status")
          .textContent =
          "Listening for analysis chunks";

        $("#live-substatus")
          .textContent =
          "Every chunk follows the real upload pipeline.";
      } catch (error) {
        $("#live-substatus")
          .textContent =
          `Microphone unavailable: ${error.message}`;
      }
    }
  );

$("#live-stop")
  .addEventListener(
    "click",
    () => {
      state.mediaRecorder?.stop();

      state.liveStream
        ?.getTracks()
        .forEach(
          (track) =>
            track.stop()
        );

      $("#live-start")
        .classList.remove(
          "hidden"
        );

      $("#live-stop")
        .classList.add(
          "hidden"
        );

      $("#live-badge")
        .textContent =
        "IDLE";

      $("#live-badge")
        .style.color =
        "var(--muted)";

      $("#live-status")
        .textContent =
        "Capture stopped";

      $("#live-substatus")
        .textContent =
        "Start again to analyze new chunks.";
    }
  );

$$("[data-action='refresh']")
  .forEach(
    (button) =>
      button.addEventListener(
        "click",
        async () => {
          updateDashboardDateTime();

          await loadHealth();
          await loadEvents();
          await loadIncidents();

          if (
            pageMeta[
              location.hash.replace(
                "#",
                ""
              )
            ]
          ) {
            const current =
              location.hash.replace(
                "#",
                ""
              );

            if (
              current ===
              "evaluation"
            ) {
              await loadEvaluation();
            }
          }
        }
      )
  );

const initialView =
  location.hash.replace(
    "#",
    ""
  );

setView(
  pageMeta[initialView]
    ? initialView
    : "dashboard"
);

updateDashboardDateTime();

setInterval(
  updateDashboardDateTime,
  1000
);


/*
|--------------------------------------------------------------------------
| ANALYSIS → EVALUATION
|--------------------------------------------------------------------------
| Adds an already-analyzed recording to the labeled evaluation dataset.
| Ground truth must come from independent knowledge of the recording.
*/

function renderEvaluationAction() {
  const resultPanel = $("#result-panel");

  if (!resultPanel || !state.result) {
    return;
  }

  let existing = $("#analysis-evaluation-action");

  if (!existing) {
    existing = document.createElement("section");

    existing.id =
      "analysis-evaluation-action";

    existing.className =
      "panel evaluation-action-panel";

    resultPanel.appendChild(existing);
  }

  const result =
    state.result;

  const alreadyAdded =
    state.evaluationSamples?.some(
      (sample) =>
        sample.analysis_id ===
        result.analysis_id
    );

  existing.innerHTML = `
    <div class="panel-heading">
      <div>
        <p class="eyebrow">
          MODEL VALIDATION
        </p>

        <h3>
          Add this analysis to evaluation
        </h3>
      </div>

      <span class="mono muted">
        GROUND TRUTH REQUIRED
      </span>
    </div>

    <p class="muted evaluation-note">
      Only add this recording when you independently know whether
      the audio is REAL or FAKE. Do not use VoiceShield's prediction
      as the ground truth.
    </p>

    <div class="field-grid">
      <label>
        <span>
          Actual recording class
        </span>

        <select
          id="analysis-ground-truth"
          ${alreadyAdded ? "disabled" : ""}
        >
          <option value="REAL">
            REAL
          </option>

          <option value="FAKE">
            FAKE
          </option>
        </select>
      </label>

      <label>
        <span>
          Model score
        </span>

        <input
          type="text"
          value="${Number(
            result.model_score
          ).toFixed(1)}/100"
          disabled
        >
      </label>
    </div>

    <div
      style="
        display:flex;
        gap:12px;
        align-items:center;
        margin-top:16px;
        flex-wrap:wrap;
      "
    >
      <button
        id="add-analysis-to-evaluation"
        class="primary-button compact"
        type="button"
        ${alreadyAdded ? "disabled" : ""}
      >
        ${
          alreadyAdded
            ? "Already added ✓"
            : "Add to evaluation"
        }
      </button>

      <span
        id="analysis-evaluation-status"
        class="muted"
      ></span>
    </div>
  `;

  const button =
    $("#add-analysis-to-evaluation");

  if (!button || alreadyAdded) {
    return;
  }

  button.addEventListener(
    "click",
    async () => {
      const groundTruth =
        $("#analysis-ground-truth")
          ?.value;

      if (
        groundTruth !== "REAL" &&
        groundTruth !== "FAKE"
      ) {
        return;
      }

      button.disabled = true;

      button.textContent =
        "Adding…";

      const status =
        $("#analysis-evaluation-status");

      if (status) {
        status.textContent =
          "Saving labeled evaluation sample…";
      }

      try {
        const data =
          await api(
            "/api/evaluation/from-analysis",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",
              },

              body: JSON.stringify({
                expected_label:
                  groundTruth,

                model_score:
                  Number(
                    result.model_score
                  ),

                analysis_id:
                  result.analysis_id,

                filename:
                  result.filename,

                source:
                  "analysis_result",

                notes:
                  "Added directly from a completed VoiceShield analysis.",
              }),
            }
          );

        button.textContent =
          "Added to evaluation ✓";

        const select =
          $("#analysis-ground-truth");

        if (select) {
          select.disabled =
            true;
        }

        if (status) {
          status.textContent =
            `Stored as ${groundTruth}. Detector prediction: ${
              data.sample
                ?.predicted_label ||
              "—"
            }.`;
        }

        await loadEvaluation();

      } catch (error) {
        button.disabled = false;

        button.textContent =
          "Add to evaluation";

        if (status) {
          status.textContent =
            error.message;
        }
      }
    }
  );
}


loadHealth();
loadEvents();
loadIncidents();