/*
|--------------------------------------------------------------------------
| VOICESHIELD AI — MODEL AGREEMENT
|--------------------------------------------------------------------------
|
| V2 / V4 consistency diagnostic.
|
| IMPORTANT:
| - This is NOT accuracy.
| - This is NOT confidence.
| - This does NOT determine which model is correct.
| - It only measures how closely V2 and V4 outputs agree.
|
| This file is intentionally self-contained.
| It does not require changes to app.js.
|--------------------------------------------------------------------------
*/

(function () {
  "use strict";

  const PANEL_ID =
    "model-agreement";

  const STYLE_ID =
    "model-agreement-styles";

  let lastV2 = null;
  let lastV4 = null;


  /*
  |--------------------------------------------------------------------------
  | Utility
  |--------------------------------------------------------------------------
  */

  function getNumber(value) {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    const cleaned =
      String(value)
        .replace("%", "")
        .replace("/100", "")
        .trim();

    const number =
      Number(cleaned);

    return Number.isFinite(number)
      ? number
      : null;
  }


  function getDisplayedScore(selector) {
    const element =
      document.querySelector(selector);

    if (!element) {
      return null;
    }

    return getNumber(
      element.textContent
    );
  }


  /*
  |--------------------------------------------------------------------------
  | Agreement calculation
  |--------------------------------------------------------------------------
  */

  function calculateDifference(
    v2,
    v4
  ) {
    if (
      !Number.isFinite(v2) ||
      !Number.isFinite(v4)
    ) {
      return null;
    }

    return Math.abs(v2 - v4);
  }


  function getAgreementLevel(
    difference
  ) {
    if (!Number.isFinite(difference)) {
      return "UNKNOWN";
    }

    /*
     * Difference <= 10:
     * closely aligned
     */
    if (difference <= 10) {
      return "HIGH";
    }

    /*
     * Difference > 10 and <= 25:
     * noticeable difference
     */
    if (difference <= 25) {
      return "MODERATE";
    }

    /*
     * Difference > 25:
     * substantial disagreement
     */
    return "LOW";
  }


  function getInterpretation(
    level
  ) {
    switch (level) {
      case "HIGH":
        return {
          title:
            "Strong model agreement",

          message:
            "V2 and V4 produced closely aligned voice assessments. This indicates consistency between the two model outputs, but it does not establish detection accuracy.",
        };

      case "MODERATE":
        return {
          title:
            "Some model disagreement",

          message:
            "V2 and V4 differ noticeably. Consider the model result together with contextual signals and use secondary verification for sensitive actions.",
        };

      case "LOW":
        return {
          title:
            "Significant model disagreement",

          message:
            "V2 and V4 differ substantially. Treat the model result cautiously and use secondary verification before high-impact actions.",
        };

      default:
        return {
          title:
            "Agreement unavailable",

          message:
            "Model agreement could not be calculated because one or more model outputs are unavailable.",
        };
    }
  }


  /*
  |--------------------------------------------------------------------------
  | Styling
  |--------------------------------------------------------------------------
  */

  function injectStyles() {
    if (
      document.getElementById(
        STYLE_ID
      )
    ) {
      return;
    }

    const style =
      document.createElement(
        "style"
      );

    style.id =
      STYLE_ID;

    style.textContent = `
      #model-agreement {
        margin-top: 14px;
        padding: 22px;
        border: 1px solid var(--line, rgba(255,255,255,.08));
        border-radius: 9px;
        background:
          linear-gradient(
            140deg,
            rgba(16,36,54,.84),
            rgba(10,24,37,.85)
          );
        box-shadow:
          0 17px 55px rgba(0,0,0,.12);
      }

      #model-agreement
      .model-agreement-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
      }

      #model-agreement
      .model-agreement-eyebrow {
        margin: 0;
        color: var(--teal, #5ee7d2);
        font: 9px var(--mono, monospace);
        letter-spacing: .13em;
      }

      #model-agreement
      .model-agreement-title {
        margin: 6px 0 0;
        color: var(--text, #edf7f6);
        font-size: 16px;
        font-weight: 700;
        letter-spacing: -.04em;
      }

      #model-agreement
      .model-agreement-badge {
        flex: none;
        padding: 6px 9px;
        border: 1px solid
          rgba(94,231,210,.3);
        border-radius: 4px;
        color: var(--teal, #5ee7d2);
        background:
          rgba(94,231,210,.05);
        font: 8px var(--mono, monospace);
        letter-spacing: .09em;
      }

      #model-agreement
      .model-agreement-badge.moderate {
        color: var(--orange, #ffb86a);
        border-color:
          rgba(255,184,106,.35);
        background:
          rgba(255,184,106,.05);
      }

      #model-agreement
      .model-agreement-badge.low {
        color: var(--red, #ff7e85);
        border-color:
          rgba(255,126,133,.35);
        background:
          rgba(255,126,133,.05);
      }

      #model-agreement
      .model-agreement-badge.unknown {
        color: var(--muted, #91a5b3);
        border-color:
          var(--line, rgba(255,255,255,.08));
        background:
          transparent;
      }

      #model-agreement
      .model-agreement-grid {
        display: grid;
        grid-template-columns:
          repeat(3, minmax(0, 1fr));
        gap: 10px;
      }

      #model-agreement
      .agreement-metric {
        min-height: 78px;
        padding: 14px;
        border: 1px solid
          var(--line, rgba(255,255,255,.08));
        border-radius: 7px;
        background:
          rgba(5,16,27,.38);
      }

      #model-agreement
      .agreement-metric-label {
        display: block;
        margin-bottom: 9px;
        color: var(--muted, #91a5b3);
        font: 9px var(--mono, monospace);
        text-transform: uppercase;
        letter-spacing: .06em;
      }

      #model-agreement
      .agreement-metric-value {
        display: block;
        color: var(--text, #edf7f6);
        font: 18px var(--mono, monospace);
      }

      #model-agreement
      .agreement-interpretation {
        margin-top: 12px;
        padding: 14px;
        border-left: 2px solid
          var(--teal, #5ee7d2);
        background:
          rgba(94,231,210,.04);
      }

      #model-agreement
      .agreement-interpretation.moderate {
        border-left-color:
          var(--orange, #ffb86a);
        background:
          rgba(255,184,106,.04);
      }

      #model-agreement
      .agreement-interpretation.low {
        border-left-color:
          var(--red, #ff7e85);
        background:
          rgba(255,126,133,.04);
      }

      #model-agreement
      .agreement-interpretation-title {
        display: block;
        color: var(--text, #edf7f6);
        font-size: 11px;
      }

      #model-agreement
      .agreement-interpretation-message {
        margin: 6px 0 0;
        color: var(--muted, #91a5b3);
        font-size: 10px;
        line-height: 1.6;
      }

      #model-agreement
      .agreement-note {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        margin-top: 13px;
        padding-top: 13px;
        border-top: 1px solid
          var(--line, rgba(255,255,255,.08));
        color: var(--muted, #91a5b3);
        font: 9px var(--mono, monospace);
        line-height: 1.5;
      }

      #model-agreement
      .agreement-note-label {
        flex: none;
        color: var(--faint, #607585);
        letter-spacing: .08em;
      }

      @media (max-width: 760px) {
        #model-agreement
        .model-agreement-grid {
          grid-template-columns: 1fr;
        }

        #model-agreement
        .model-agreement-header {
          flex-direction: column;
        }

        #model-agreement
        .model-agreement-badge {
          align-self: flex-start;
        }
      }
    `;

    document.head.appendChild(
      style
    );
  }


  /*
  |--------------------------------------------------------------------------
  | Panel creation
  |--------------------------------------------------------------------------
  */

  function createPanel() {
    let panel =
      document.getElementById(
        PANEL_ID
      );

    if (panel) {
      return panel;
    }

    const resultPanel =
      document.querySelector(
        "#result-panel"
      );

    if (!resultPanel) {
      return null;
    }

    panel =
      document.createElement(
        "section"
      );

    panel.id =
      PANEL_ID;

    /*
     * Insert directly after the
     * existing result cards.
     */
    const resultCards =
      resultPanel.querySelector(
        ".result-cards"
      );

    if (resultCards) {
      resultCards.insertAdjacentElement(
        "afterend",
        panel
      );
    } else {
      resultPanel.appendChild(
        panel
      );
    }

    return panel;
  }


  /*
  |--------------------------------------------------------------------------
  | Render unavailable state
  |--------------------------------------------------------------------------
  */

  function renderUnavailable(
    panel
  ) {
    panel.innerHTML = `
      <div class="model-agreement-header">

        <div>
          <p class="model-agreement-eyebrow">
            MODEL CONSISTENCY
          </p>

          <h3 class="model-agreement-title">
            V2 / V4 agreement
          </h3>
        </div>

        <span
          class="
            model-agreement-badge
            unknown
          "
        >
          UNAVAILABLE
        </span>

      </div>

      <p
        class="agreement-interpretation-message"
      >
        Model agreement could not be calculated
        because one or more model outputs are
        unavailable.
      </p>

      <div class="agreement-note">

        <span
          class="agreement-note-label"
        >
          DIAGNOSTIC SIGNAL
        </span>

        <span>
          Agreement is a consistency measure
          between V2 and V4. It is not model
          accuracy or confidence.
        </span>

      </div>
    `;
  }


  /*
  |--------------------------------------------------------------------------
  | Render agreement
  |--------------------------------------------------------------------------
  */

  function renderAgreement(
    v2,
    v4
  ) {
    const panel =
      createPanel();

    if (!panel) {
      return;
    }

    if (
      !Number.isFinite(v2) ||
      !Number.isFinite(v4)
    ) {
      renderUnavailable(
        panel
      );

      return;
    }

    const difference =
      calculateDifference(
        v2,
        v4
      );

    const level =
      getAgreementLevel(
        difference
      );

    const interpretation =
      getInterpretation(
        level
      );

    const levelClass =
      level === "MODERATE"
        ? "moderate"
        : level === "LOW"
        ? "low"
        : level === "UNKNOWN"
        ? "unknown"
        : "";

    panel.innerHTML = `
      <div class="model-agreement-header">

        <div>

          <p class="model-agreement-eyebrow">
            MODEL CONSISTENCY
          </p>

          <h3 class="model-agreement-title">
            V2 / V4 agreement
          </h3>

        </div>

        <span
          class="
            model-agreement-badge
            ${levelClass}
          "
        >
          ${level}
        </span>

      </div>


      <div class="model-agreement-grid">

        <div class="agreement-metric">

          <span
            class="agreement-metric-label"
          >
            V2 score
          </span>

          <strong
            class="agreement-metric-value"
          >
            ${v2.toFixed(1)}/100
          </strong>

        </div>


        <div class="agreement-metric">

          <span
            class="agreement-metric-label"
          >
            V4 score
          </span>

          <strong
            class="agreement-metric-value"
          >
            ${v4.toFixed(1)}/100
          </strong>

        </div>


        <div class="agreement-metric">

          <span
            class="agreement-metric-label"
          >
            Difference
          </span>

          <strong
            class="agreement-metric-value"
          >
            ${difference.toFixed(1)}
          </strong>

        </div>

      </div>


      <div
        class="
          agreement-interpretation
          ${levelClass}
        "
      >

        <strong
          class="agreement-interpretation-title"
        >
          ${interpretation.title}
        </strong>

        <p
          class="
            agreement-interpretation-message
          "
        >
          ${interpretation.message}
        </p>

      </div>


      <div class="agreement-note">

        <span
          class="agreement-note-label"
        >
          DIAGNOSTIC SIGNAL
        </span>

        <span>
          Agreement measures consistency between
          V2 and V4. It is not model accuracy,
          confidence, or proof that either model
          is correct.
        </span>

      </div>
    `;
  }


  /*
  |--------------------------------------------------------------------------
  | Detect result changes
  |--------------------------------------------------------------------------
  */

  function checkForResult() {
    const resultPanel =
      document.querySelector(
        "#result-panel"
      );

    if (!resultPanel) {
      return;
    }

    /*
     * Do not display the agreement panel
     * before an actual result exists.
     */
    if (
      resultPanel.classList.contains(
        "hidden"
      )
    ) {
      return;
    }

    const v2 =
      getDisplayedScore(
        "#v2-score"
      );

    const v4 =
      getDisplayedScore(
        "#v4-score"
      );

    /*
     * Avoid unnecessary DOM updates.
     */
    if (
      v2 === lastV2 &&
      v4 === lastV4
    ) {
      return;
    }

    lastV2 =
      v2;

    lastV4 =
      v4;

    renderAgreement(
      v2,
      v4
    );
  }


  /*
  |--------------------------------------------------------------------------
  | Observe application changes
  |--------------------------------------------------------------------------
  */

  function startObserver() {
    const observer =
      new MutationObserver(
        function () {
          checkForResult();
        }
      );

    observer.observe(
      document.body,
      {
        childList: true,
        subtree: true,
        characterData: true,
      }
    );

    /*
     * Also check periodically.
     *
     * This protects against application
     * updates that change text/properties
     * without triggering the expected
     * mutation sequence.
     */
    setInterval(
      checkForResult,
      500
    );
  }


  /*
  |--------------------------------------------------------------------------
  | Initialize
  |--------------------------------------------------------------------------
  */

  function initialize() {
    injectStyles();

    checkForResult();

    startObserver();
  }


  /*
  |--------------------------------------------------------------------------
  | Wait for DOM
  |--------------------------------------------------------------------------
  */

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      initialize
    );
  } else {
    initialize();
  }

})();