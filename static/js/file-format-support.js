/*
|--------------------------------------------------------------------------
| VOICESHIELD AI — FILE FORMAT SUPPORT
|--------------------------------------------------------------------------
|
| Enables upload selection for audio files and video containers
| that may contain an audio track.
|
| IMPORTANT:
| This only controls the browser file picker.
| The backend must also allow the same extensions.
|--------------------------------------------------------------------------
*/

(function () {
  "use strict";

  const SUPPORTED_EXTENSIONS = [
    ".wav",
    ".mp3",
    ".m4a",
    ".aac",
    ".ogg",
    ".flac",
    ".webm",
    ".aiff",
    ".aif",
    ".mp4",
    ".mov",
    ".mkv",
  ];

  const ACCEPT_VALUE =
    [
      "audio/*",
      "video/mp4",
      "video/quicktime",
      "video/x-matroska",
      ...SUPPORTED_EXTENSIONS,
    ].join(",");

  function applyFileFormatSupport() {
    const input =
      document.querySelector("#audio-file");

    if (!input) {
      return;
    }

    input.setAttribute(
      "accept",
      ACCEPT_VALUE
    );

    input.dataset.supportedFormats =
      SUPPORTED_EXTENSIONS.join(",");

    const description =
      document.querySelector(
        "#audio-format-description"
      );

    if (description) {
      description.textContent =
        "Audio: WAV, MP3, M4A, AAC, OGG, FLAC, WebM, AIFF/AIF · Video: MP4, MOV, MKV";
    }
  }

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      applyFileFormatSupport
    );
  } else {
    applyFileFormatSupport();
  }
})();