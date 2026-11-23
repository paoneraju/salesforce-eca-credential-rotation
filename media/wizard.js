// @ts-check
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const content = document.getElementById("content");
  const banner = document.getElementById("banner");
  const subtitle = document.getElementById("subtitle");
  const stepbar = document.getElementById("stepbar");
  const closeButton = document.getElementById("closeButton");

  let state = null;
  let lastStep = null;
  const checklist = new Set();
  let approvalTyped = "";
  let approvalChecked = false;

  const CHECKLIST = [
    "Named Credentials / External Credentials updated in every environment",
    "Secrets manager, vault, or CI/CD secret variables updated",
    "Middleware, ETL, and other connected systems updated",
    "Integration owners notified and rollback plan confirmed",
    "Old credentials scheduled for retirement only after validation"
  ];

  const STEPS = [
    ["preflight", "Checks"],
    ["staged", "Stage"],
    ["retrieved", "Retrieve"],
    ["checklist", "Update"],
    ["approval", "Approve"],
    ["result", "Verify"]
  ];

  closeButton.addEventListener("click", () => post("close"));

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "state") {
      return;
    }
    state = message;
    if (state.step !== "checklist" && lastStep === "checklist" && state.step !== "approval") {
      checklist.clear();
    }
    if (state.step === "approval" && lastStep !== "approval") {
      approvalTyped = "";
      approvalChecked = false;
    }
    if (state.step === "preflight" && lastStep === "failed") {
      checklist.clear();
    }
    lastStep = state.step;
    render();
  });

  function post(type, payload) {
    vscode.postMessage(Object.assign({ type: type }, payload || {}));
  }

  function h(tag, properties) {
    const node = document.createElement(tag);
    const props = properties || {};
    Object.keys(props).forEach((key) => {
      const value = props[key];
      if (value === undefined || value === null || value === false) {
        return;
      }
      if (key === "class") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = String(value);
      } else if (key === "value") {
        node.value = String(value);
      } else if (key === "disabled") {
        node.disabled = Boolean(value);
      } else if (key === "checked") {
        node.checked = Boolean(value);
      } else if (key === "type") {
        node.type = value;
      } else if (key === "placeholder") {
        node.placeholder = value;
      } else if (key === "title") {
        node.title = value;
      } else if (key === "autocomplete") {
        node.autocomplete = value;
      } else if (key.slice(0, 2) === "on" && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, String(value));
      }
    });
    const children = Array.prototype.slice.call(arguments, 2);
    children.forEach((child) => append(node, child));
    return node;
  }

  function append(node, child) {
    if (child === undefined || child === null || child === false) {
      return;
    }
    if (Array.isArray(child)) {
      child.forEach((entry) => append(node, entry));
      return;
    }
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
      return;
    }
    if (child instanceof Node) {
      node.appendChild(child);
    }
  }

  function button(label, onClick, options) {
    const opts = options || {};
    const classes = ["btn"];
    if (opts.primary) {
      classes.push("primary");
    }
    if (opts.danger) {
      classes.push("danger");
    }
    if (opts.secondary) {
      classes.push("secondary");
    }
    const node = h(
      "button",
      {
        class: classes.join(" "),
        type: "button",
        disabled: Boolean(opts.disabled),
        onclick: onClick,
        title: opts.title
      },
      label
    );
    return node;
  }

  function card(title, children) {
    return h("section", { class: "card" }, h("h2", { text: title }), children);
  }

  function kv(label, value, options) {
    const opts = options || {};
    const valueNode = h("span", {
      class: "kv-value" + (opts.mono ? " mono" : "") + (opts.warning ? " warn-text" : ""),
      text: value === undefined || value === null || value === "" ? "not reported" : String(value)
    });
    return h(
      "div",
      { class: "kv" },
      h("span", { class: "kv-label", text: label }),
      valueNode
    );
  }

  function formatTime(value) {
    if (!value) {
      return "not reported";
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? String(value) : new Date(parsed).toLocaleString();
  }

  function pill(text, kind) {
    return h("span", { class: "pill " + (kind || "neutral"), text: text });
  }

  function render() {
    if (!state) {
      return;
    }
    content.replaceChildren();
    subtitle.textContent =
      (state.org.alias ? state.org.alias + " / " : "") +
      state.org.username +
      " • " +
      state.eca.name;
    renderStepbar();
    renderBanner();
    switch (state.step) {
      case "preflight":
        renderPreflight();
        break;
      case "staged":
        renderStaged();
        break;
      case "retrieved":
        renderRetrieved();
        break;
      case "checklist":
        renderChecklist();
        break;
      case "approval":
        renderApproval();
        break;
      case "result":
        renderResult();
        break;
      case "failed":
        renderFailed();
        break;
      default:
        content.appendChild(h("p", { text: "Unknown wizard state." }));
    }
    if (state.busy) {
      content.setAttribute("aria-busy", "true");
      content.querySelectorAll("button").forEach((node) => {
        node.disabled = true;
      });
      const busy = h("div", { class: "busy" }, h("span", { class: "spinner" }), "Working…");
      content.prepend(busy);
    } else {
      content.removeAttribute("aria-busy");
    }
  }

  function renderStepbar() {
    stepbar.replaceChildren();
    const current = STEPS.findIndex((entry) => entry[0] === state.step);
    STEPS.forEach((entry, index) => {
      const classes = ["step"];
      if (current === index) {
        classes.push("active");
      } else if (current > index || state.step === "result") {
        classes.push("done");
      }
      stepbar.appendChild(
        h(
          "div",
          { class: classes.join(" ") },
          h("span", { class: "step-index", text: String(index + 1) }),
          h("span", { class: "step-name", text: entry[1] })
        )
      );
    });
  }

  function renderBanner() {
    banner.replaceChildren();
    banner.className = "banner";
    if (state.error) {
      banner.classList.add("error");
      banner.appendChild(h("strong", { text: "Operation not completed. " }));
      banner.appendChild(document.createTextNode(state.error.message));
      if (state.error.auditId) {
        banner.appendChild(
          h("div", { class: "banner-small", text: "Audit record: " + state.error.auditId })
        );
      }
      return;
    }
    if (state.notice) {
      banner.classList.add("notice");
      banner.appendChild(document.createTextNode(state.notice));
      return;
    }
    banner.classList.add("hidden");
  }

  function targetCard() {
    return card(
      "Target",
      h(
        "div",
        { class: "grid" },
        kv("Salesforce org", state.org.alias || state.org.username),
        kv("Username", state.org.username),
        kv("Environment", state.org.environment),
        kv("Instance", state.org.instanceUrl),
        kv("External Client App", state.eca.name),
        kv("API name", state.eca.developerName),
        kv("App identifier", state.eca.identifier, { mono: true }),
        kv("Consumer ID", state.eca.consumerId, { mono: true })
      )
    );
  }

  function renderPreflight() {
    content.appendChild(
      h(
        "div",
        { class: "hero" },
        h("h2", { text: "Pre-rotation checks" }),
        h("p", {
          class: "muted",
          text: "Verify the org, app, API access, and credential state before creating a second active credential."
        })
      )
    );
    content.appendChild(targetCard());
    const checks = (state.preflight && state.preflight.checks) || [];
    const list = h("div", { class: "checklist" });
    checks.forEach((check) => {
      list.appendChild(
        h(
          "div",
          { class: "check " + check.severity },
          h("span", { class: "check-icon", text: check.severity === "pass" ? "✓" : check.severity === "warn" ? "!" : "×" }),
          h(
            "div",
            { class: "check-body" },
            h("strong", { text: check.label }),
            h("span", { text: check.detail })
          )
        )
      );
    });
    content.appendChild(card("Checks", list));

    const existing = (state.preflight && state.preflight.existingStaged) || [];
    if (existing.length > 0) {
      const stagedList = h("div", { class: "stack" });
      existing.forEach((entry) => {
        stagedList.appendChild(
          h(
            "div",
            { class: "mini-card" },
            pill(entry.state, entry.state === "active" ? "ok" : "neutral"),
            h("span", { class: "mono", text: entry.id }),
            h("span", {
              class: "muted",
              text: entry.expirationDate ? "expires " + formatTime(entry.expirationDate) : "expiration not reported"
            })
          )
        );
      });
      content.appendChild(card("Existing staged credentials", stagedList));
    }

    const actions = h("div", { class: "actions" });
    actions.appendChild(button("Re-run checks", () => post("runChecks"), { secondary: true }));
    const canStage = Boolean(state.preflight && state.preflight.canStage);
    actions.appendChild(
      button("Stage new credentials", () => post("stage"), {
        primary: true,
        disabled: !canStage
      })
    );
    const retrievable = existing.some((entry) => entry.state === "active" || entry.state === "rotated");
    if (retrievable) {
      actions.appendChild(
        button("Retrieve existing staged credential", () => post("retrieve"), {
          secondary: true
        })
      );
    }
    actions.appendChild(button("Open External Client Apps Setup", () => post("openSetup"), { secondary: true }));
    content.appendChild(actions);

    if (!canStage) {
      content.appendChild(
        h("p", {
          class: "muted callout",
          text: "Resolve every failed check before staging. Warnings do not block staging but should be reviewed."
        })
      );
    }
    if (state.preflight && state.preflight.apiVersion) {
      content.appendChild(
        h("p", { class: "muted small", text: "Salesforce API " + state.preflight.apiVersion })
      );
    }
  }

  function renderStaged() {
    content.appendChild(
      h(
        "div",
        { class: "hero" },
        h("h2", { text: "Credentials staged" }),
        h("p", {
          class: "muted",
          text: "A new credential exists alongside the current one. It is not a rotation yet."
        })
      )
    );
    const staged = state.staged || {};
    content.appendChild(
      card(
        "Staged credential",
        h(
          "div",
          { class: "grid" },
          kv("State", staged.state),
          kv("Staged credential ID", staged.id, { mono: true }),
          kv("Created", formatTime(staged.createdDate)),
          kv("Expires", formatTime(staged.expirationDate)),
          kv("Created by", staged.createdBy)
        )
      )
    );
    content.appendChild(
      h(
        "div",
        { class: "callout warning" },
        h("strong", { text: "Both credential sets can authenticate until rotation. " }),
        "Update integrations with the new values before approving rotation. The current credentials remain valid until the rotation call succeeds."
      )
    );
    const actions = h("div", { class: "actions" });
    actions.appendChild(button("Retrieve staged credentials", () => post("retrieve"), { primary: true }));
    actions.appendChild(button("Stage different credentials", () => post("stage"), { secondary: true }));
    actions.appendChild(button("Delete staged credential", () => post("deleteStaged"), { danger: true }));
    actions.appendChild(button("Re-run checks", () => post("backTo", { step: "preflight" }), { secondary: true }));
    content.appendChild(actions);
  }

  function renderRetrieved() {
    const credentials = state.credentials;
    if (!credentials) {
      content.appendChild(
        h("div", { class: "callout warning" }, "No credentials are currently held in memory.")
      );
      content.appendChild(
        h(
          "div",
          { class: "actions" },
          button("Retrieve again", () => post("retrieve"), { primary: true }),
          button("Back", () => post("backTo", { step: "staged" }), { secondary: true })
        )
      );
      return;
    }

    content.appendChild(
      h(
        "div",
        { class: "hero" },
        h("h2", { text: "New credentials" }),
        h("p", {
          class: "muted",
          text: "Copy these values into your integration secret store. They are shown only in this panel and are never written to disk."
        })
      )
    );

    const idRow = h(
      "div",
      { class: "credential-row" },
      h("div", { class: "credential-label" }, "Client ID", h("span", { class: "muted small", text: " consumer key" })),
      h("code", { class: "credential-value", text: credentials.clientId })
    );
    const idActions = h(
      "div",
      { class: "credential-actions" },
      button("Copy Client ID", () => post("copy", { field: "clientId" }), { secondary: true })
    );

    const secretShown = Boolean(credentials.revealed && credentials.secret);
    const secretRow = h(
      "div",
      { class: "credential-row" },
      h("div", { class: "credential-label" }, "Client secret"),
      h("code", {
        class: "credential-value secret" + (secretShown ? "" : " masked"),
        text: secretShown ? credentials.secret : "••••••••••••••••••••••••"
      })
    );
    const secretActions = h(
      "div",
      { class: "credential-actions" },
      secretShown
        ? button("Hide secret", () => post("hideSecret"), { secondary: true })
        : button("Reveal secret", () => post("revealSecret"), { secondary: true }),
      button("Copy Client Secret", () => post("copy", { field: "clientSecret" }), { secondary: true })
    );

    content.appendChild(
      card(
        "Credential values",
        h(
          "div",
          { class: "stack" },
          idRow,
          idActions,
          secretRow,
          secretActions,
          h("p", {
            class: "muted small",
            text:
              "Secret reveal automatically re-masks after 60 seconds. Credentials clear from memory when this panel closes or after the configured session lifetime."
          })
        )
      )
    );

    content.appendChild(
      card(
        "Credential metadata",
        h(
          "div",
          { class: "grid" },
          kv("Staged credential ID", credentials.stagedCredentialId, { mono: true }),
          kv("Retrieved", formatTime(credentials.retrievedAt)),
          kv("Salesforce expiration", formatTime(credentials.expirationDate)),
          kv(
            "Memory lifetime remaining",
            credentials.expiresInSeconds !== undefined
              ? Math.max(0, Math.ceil(credentials.expiresInSeconds / 60)) + " minute(s)"
              : "unknown"
          )
        )
      )
    );

    content.appendChild(
      h(
        "div",
        { class: "callout warning" },
        h("strong", { text: "Clipboard warning. " }),
        "Copied credentials may be readable by other applications on this machine. Clear your clipboard after updating your secret store."
      )
    );

    const actions = h("div", { class: "actions" });
    actions.appendChild(button("Continue to integration checklist", () => post("openChecklist"), { primary: true }));
    actions.appendChild(button("Clear credentials from memory", () => post("clearCredentials"), { danger: true }));
    actions.appendChild(button("Back to staged credential", () => post("backTo", { step: "staged" }), { secondary: true }));
    content.appendChild(actions);
  }

  function renderChecklist() {
    content.appendChild(
      h(
        "div",
        { class: "hero" },
        h("h2", { text: "Integration update checklist" }),
        h("p", {
          class: "muted",
          text: "Complete these steps before activating the new credentials. Rotation invalidates the current secret immediately."
        })
      )
    );

    const list = h("div", { class: "checklist" });
    CHECKLIST.forEach((item, index) => {
      const id = "check-" + index;
      const checkbox = h("input", {
        type: "checkbox",
        id: id,
        checked: checklist.has(index),
        onchange: (event) => {
          if (event.target.checked) {
            checklist.add(index);
          } else {
            checklist.delete(index);
          }
          continueButton.disabled = checklist.size !== CHECKLIST.length;
        }
      });
      list.appendChild(
        h("label", { class: "check-item", for: id }, checkbox, h("span", { text: item }))
      );
    });
    content.appendChild(card("Checklist", list));

    const continueButton = button(
      "Continue to approval",
      () => post("checklistComplete", { acknowledged: true }),
      {
        primary: true,
        disabled: checklist.size !== CHECKLIST.length
      }
    );

    const actions = h("div", { class: "actions" });
    actions.appendChild(continueButton);
    actions.appendChild(button("Back to credentials", () => post("backTo", { step: "retrieved" }), { secondary: true }));
    content.appendChild(actions);
    content.appendChild(
      h("p", {
        class: "muted small",
        text: "The extension requires a second, native confirmation with the selected org and External Client App immediately before rotation."
      })
    );
  }

  function renderApproval() {
    content.appendChild(
      h(
        "div",
        { class: "hero" },
        h("h2", { text: "Approve credential rotation" }),
        h("p", {
          class: "muted",
          text: "Review the exact target, then type the app API name and confirm the consequence."
        })
      )
    );
    content.appendChild(targetCard());
    content.appendChild(
      h(
        "div",
        { class: "callout danger" },
        h("strong", { text: "Irreversible from this extension. " }),
        "Rotating replaces the current consumer key and secret. Integrations that still use the old credentials stop authenticating immediately. The old credentials are not restored by this extension."
      )
    );
    if (state.checklistAcknowledged) {
      content.appendChild(
        h("div", { class: "callout ok" }, "Integration update checklist acknowledged.")
      );
    }

    const input = h("input", {
      type: "text",
      class: "text-input",
      id: "approval-name",
      value: approvalTyped,
      placeholder: state.eca.developerName,
      autocomplete: "off",
      "aria-label": "Type the External Client App API name to confirm"
    });
    const check = h("input", {
      type: "checkbox",
      id: "approval-check",
      checked: approvalChecked
    });
    const approveButton = button("Rotate credentials now", () => {
      post("rotate", {
        typedEcaName: approvalTyped,
        checklistAcknowledged: true
      });
    }, {
      danger: true,
      disabled: approvalTyped.trim() !== state.eca.developerName || !approvalChecked
    });
    approveButton.id = "approve-button";

    function update() {
      approveButton.disabled =
        approvalTyped.trim() !== state.eca.developerName || !approvalChecked || Boolean(state.busy);
    }

    input.addEventListener("input", () => {
      approvalTyped = input.value;
      update();
    });
    check.addEventListener("change", () => {
      approvalChecked = check.checked;
      update();
    });

    content.appendChild(
      card(
        "Explicit approval",
        h(
          "div",
          { class: "stack" },
          h("label", { class: "field-label", for: "approval-name" }, "Type the External Client App API name: ", h("code", { text: state.eca.developerName })),
          input,
          h(
            "label",
            { class: "check-item", for: "approval-check" },
            check,
            h("span", {
              text: "I understand that the current client ID and secret will stop working after rotation."
            })
          ),
          approveButton
        )
      )
    );

    const actions = h("div", { class: "actions" });
    actions.appendChild(button("Back to checklist", () => post("backTo", { step: "checklist" }), { secondary: true }));
    content.appendChild(actions);
  }

  function resultValue(label, value, mono) {
    return kv(label, value, { mono: Boolean(mono) });
  }

  function renderResult() {
    const result = state.result;
    if (!result) {
      renderFailed();
      return;
    }
    const verified = result.status === "verified";
    content.appendChild(
      h(
        "div",
        { class: "hero" },
        h("h2", { text: "Rotation outcome" }),
        h(
          "div",
          { class: "outcome " + (verified ? "ok" : "warning") },
          h("strong", { text: verified ? "Verified" : "Unverified" }),
          h("span", {
            text: verified
              ? "Salesforce state and the active client ID match the new credential."
              : "The rotation request did not fully verify. Do not assume the new credentials are active."
          })
        )
      )
    );
    content.appendChild(
      card(
        "Verification",
        h(
          "div",
          { class: "grid" },
          resultValue("Status", result.status),
          resultValue("Rotated at", formatTime(result.rotatedAt)),
          resultValue("HTTP status", String(result.httpStatus)),
          resultValue("Salesforce org", state.org.alias || state.org.username),
          resultValue("External Client App", state.eca.developerName),
          resultValue("Administrator", result.admin),
          resultValue("API version", result.apiVersion),
          resultValue("Staged state", result.verification.stagedState),
          resultValue("Active client ID matches", result.verification.activeConsumerKeyMatches ? "yes" : "no"),
          resultValue("Active client ID suffix", result.verification.consumerKeySuffix),
          resultValue("Staged credential", result.staged.id, true),
          resultValue("Audit ID", result.auditId, true)
        )
      )
    );
    content.appendChild(
      h(
        "div",
        { class: "callout warning" },
        h("strong", { text: "Not an authentication test. " }),
        result.verification.detail
      )
    );

    const actions = h("div", { class: "actions" });
    actions.appendChild(button("Open audit record", () => post("openAudit"), { secondary: true }));
    if (state.result && state.result.staged && state.result.staged.id) {
      actions.appendChild(
        button("Delete staged credential", () => post("deleteStaged"), { danger: true })
      );
    }
    actions.appendChild(button("Start over", () => post("restart"), { secondary: true }));
    actions.appendChild(button("Close", () => post("close"), { secondary: true }));
    content.appendChild(actions);
  }

  function renderFailed() {
    content.appendChild(
      h(
        "div",
        { class: "hero" },
        h("h2", { text: "Operation failed" }),
        h("p", {
          class: "muted",
          text: "No success is claimed. Review the error and the audit record before retrying."
        })
      )
    );
    content.appendChild(
      h(
        "div",
        { class: "callout danger" },
        h("strong", { text: "Error. " }),
        (state.error && state.error.message) || "Unknown error."
      )
    );
    if (state.error && state.error.auditId) {
      content.appendChild(
        card(
          "Audit record",
          h(
            "div",
            { class: "grid" },
            kv("Audit ID", state.error.auditId, { mono: true }),
            kv("File", state.error.auditPath || "not available")
          )
        )
      );
    }
    const actions = h("div", { class: "actions" });
    actions.appendChild(button("Retry pre-rotation checks", () => post("backTo", { step: "preflight" }), { primary: true }));
    if (state.error && state.error.auditId) {
      actions.appendChild(button("Open audit record", () => post("openAudit"), { secondary: true }));
    }
    actions.appendChild(button("Close", () => post("close"), { secondary: true }));
    content.appendChild(actions);
  }

  post("ready");
})();
