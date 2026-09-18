/*
|--------------------------------------------------------------------------
| VOICESHIELD AI — MODEL AGREEMENT
|--------------------------------------------------------------------------
|
| Compares the independently returned V2 and V4 model scores.
|
| IMPORTANT:
| - This is NOT accuracy.
| - This is NOT confidence.
| - This does NOT prove which model is correct.
| - It is only a consistency / disagreement diagnostic.
|--------------------------------------------------------------------------
*/

(function () {
  "use strict";

  function getNumber(value) {
    const number = Number(value);

    return Number.isFinite(number)
      ? number
      : null;
  }

  function getAgreementLevel(difference) {
    if (!Number.isFinite(difference)) {
      return "UNKNOWN";
    }

    if (difference <= 10) {
      return "HIGH";
    }

    if (difference <= 25) {
      return "MODERATE";
    }

    return "LOW";
  }

  function getInterpretation(level) {
    switch (level) {
      case "HIGH":
        return {
          title: "Strong model agreement",
          message:
            "V2 and V4 produced closely aligned voice assessments. This indicates consistency between the two model outputs, but it does not establish detection accuracy.",
        };

      case "MODERATE":
        return {
          title: "Some model disagreement",
          message:
            "V2 and V4 differ noticeably. Consider the model result together with contextual signals and use secondary verification for sensitive actions.",
        };

      case "LOW":
        return {
          title: "Significant model disagreement",
          message:
            "V2 and V4 differ substantially. Treat the model result cautiously and use secondary verification before high-impact actions.",
        };

      default:
        return {
          title: "Agreement unavailable",
          message:
            "The application could not calculate model agreement because one or more model outputs were unavailable.",
        };
    }
  }

  function createPanel() {
    const resultPanel =
      document.querySelector("#result-panel");

    if (!resultPanel) {
      return null;
    }

    let panel =
      document.querySelector(
        "#model-agreement"
      );

    if (panel) {
      return panel;
    }

    panel =
      document.createElement("section");

    panel.id =
      "model-agreement";

    panel.className =
      "panel model-agreement-panel";

    /*
     * Place the agreement panel near the
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
      resultPanel.prepend(panel);
    }

    return panel;
  }

  function renderAgreement(result) {
    if (!result) {
      return;
    }

    const v2 =
      getNumber(result.v2_score);

    const v4 =
      getNumber(result.v4_score);

    const panel =
      createPanel();

    if (!panel) {
      return;
    }

    if (
      v2 === null ||
      v4 === null
    ) {
      panel.innerHTML = `
        <div class="panel-heading">
          <div>
            <p class="eyebrow">
              MODEL CONSISTENCY
            </p>

            <h3>
              V2 / V4 agreement
            </h3>
          </div>

          <span class="mono muted">
            UNAVAILABLE
          </span>
        </div>

        <p class="muted">
          Model agreement could not be calculated because
          one or more model outputs were unavailable.
        </p>
      `;

      return;
    }

    const difference =
      Math.abs(v2 - v4);

    const level =
      getAgreementLevel(
        difference
      );

    const interpretation =
      getInterpretation(level);

    const levelClass =
      level === "HIGH"
        ? "good"
        : level === "MODERATE"
        ? "orange"
        : "high";

    panel.innerHTML = `
      <div class="panel-heading">
        <div>
          <p class="eyebrow">
            MODEL CONSISTENCY
          </p>

          <h3>
            V2 / V4 agreement
          </h3>
        </div>

        <span
          class="table-status ${levelClass}"
        >
          ${level}
        </span>
      </div>

      <div class="model-agreement-grid">

        <div class="agreement-metric">
          <span class="muted">
            V2 score
          </span>

          <strong>
            ${v2.toFixed(1)}/100
          </strong>
        </div>

        <div class="agreement-metric">
          <span class="muted">
            V4 score
          </span>

          <strong>
            ${v4.toFixed(1)}/100
          </strong>
        </div>

        <div class="agreement-metric">
          <span class="muted">
            Difference
          </span>

          <strong>
            ${difference.toFixed(1)} points
          </strong>
        </div>

      </div>

      <div class="model-agreement-interpretation">

        <strong>
          ${interpretation.title}
        </strong>

        <p class="muted">
          ${interpretation.message}
        </p>

      </div>

      <div class="model-agreement-note">
        <span class="mono">
          DIAGNOSTIC SIGNAL
        </span>

        <span>
          Agreement is a consistency measure between
          V2 and V4. It is not model accuracy or confidence.
        </span>
      </div>
    `;
  }

  /*
   * Expose the renderer so the existing application
   * can call it after every analysis.
   */
  window.VoiceShieldModelAgreement = {
    render: renderAgreement,
  };

})();