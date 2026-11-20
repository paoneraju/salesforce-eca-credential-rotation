import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildWizardHtml, escapeHtml } from "../ui/wizard/wizardHtml";

describe("wizard HTML", () => {
  it("escapes untrusted text", () => {
    assert.equal(escapeHtml('<script>"&\'</script>'), "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;");
  });

  it("uses a strict CSP with a per-panel nonce", () => {
    const html = buildWizardHtml({
      cspSource: "vscode-resource:",
      nonce: "nonce-value-123",
      scriptUri: "vscode-resource://media/wizard.js",
      styleUri: "vscode-resource://media/wizard.css"
    });
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-nonce-value-123'/);
    assert.match(html, /style-src vscode-resource:/);
    assert.equal(html.includes("unsafe-inline"), false);
    assert.equal(html.includes("unsafe-eval"), false);
  });

  it("contains only a static shell for dynamic values", () => {
    const html = buildWizardHtml({
      cspSource: "vscode-resource:",
      nonce: "abc",
      scriptUri: "vscode-resource://media/wizard.js",
      styleUri: "vscode-resource://media/wizard.css"
    });
    assert.equal(html.includes("admin@example.com"), false);
    assert.equal(html.includes("CLIENT_SECRET"), false);
    assert.match(html, /id="content"/);
    assert.match(html, /id="banner"/);
  });

  it("does not render a validation action on the rotation result screen", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "..", "media", "wizard.js"), "utf8");
    assert.equal(script.includes("Validate new credentials"), false);
  });
});
