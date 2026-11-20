export interface WizardHtmlOptions {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Static shell only. All org/app/credential values arrive through postMessage and are
 * rendered with DOM textContent, never interpolated into HTML.
 */
export function buildWizardHtml(options: WizardHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `img-src ${options.cspSource} data:`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="color-scheme" content="light dark">
  <link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
  <title>Rotate ECA Credentials</title>
</head>
<body>
  <header class="wizard-header">
    <div class="wizard-heading">
      <h1>Rotate ECA Credentials</h1>
      <p id="subtitle" class="subtitle"></p>
    </div>
    <button id="closeButton" class="btn secondary" type="button">Close</button>
  </header>
  <nav id="stepbar" class="stepbar" aria-label="Rotation progress"></nav>
  <div id="banner" class="banner hidden" role="status"></div>
  <main id="content" class="content" aria-live="polite"></main>
  <footer class="footer">
    <span>Credentials are held in memory only and are never written to the audit log.</span>
    <span>Clipboard contents may be accessible to other applications.</span>
  </footer>
  <script nonce="${options.nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>`;
}
