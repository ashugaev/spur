/* Spur snippet SDK v1 and generic component library.
 * Inlined by the host into the snippet srcdoc; never loaded over the network.
 * Message type strings mirror src/lib/snippets/snippet-protocol.ts
 * (guarded by src/__tests__/snippet-sdk.test.ts). All colors come from the
 * host theme tokens as --spur-<token> custom properties. */
(function () {
  "use strict";

  const MSG = {
    hello: "spur:hello",
    connect: "spur:connect",
    invoke: "invoke",
    stateSet: "state-set",
    fullscreen: "fullscreen",
    resize: "resize",
    escape: "escape",
    invokeResult: "invoke-result",
    stateAck: "state-ack",
    action: "action",
    theme: "theme",
    availability: "availability",
  };
  const PROTOCOL_VERSION = 1;
  const HELLO_INTERVAL_MS = 200;
  const HELLO_MAX = 25;
  const STATE_WINDOW_MS = 500;
  const STATE_MAX_BYTES = 64 * 1024;
  const TERMINAL = ["completed", "replaced", "error", "delivery_unknown", "timeout"];
  const RETRYABLE = ["error", "delivery_unknown", "timeout"];
  const STATUS_LABELS = {
    awaiting_confirm: "Confirm to send",
    submitting: "Sent",
    accepted: "Sent",
    queued: "Queued",
    processing: "Agent working",
    completed: "Done",
    replaced: "Replaced",
    error: "Send failed",
    delivery_unknown: "Delivery unknown",
    timeout: "No reply in 15 min",
  };
  const REJECTION_TEXT = {
    not_connected: "Snippet is not connected.",
    revision_conflict:
      "This revision changed in place. Actions are blocked until the next revision.",
    unknown_action: "Unknown action.",
    payload_too_large: "Payload is too large.",
    invalid_payload: "Invalid payload.",
    session_unavailable: "The session is not accepting messages.",
    busy: "Another action is still in flight.",
    declined: "Action discarded.",
    stale: "Snippet was replaced before the action was sent.",
  };
  const ISSUE_WORDS = {
    type: "wrong type",
    required: "required",
    unknown_property: "unknown property",
    min_length: "min length",
    max_length: "max length",
    enum: "not an allowed value",
    minimum: "below minimum",
    maximum: "above maximum",
    integer: "must be an integer",
    min_items: "min items",
    max_items: "max items",
    selection_mismatch: "selection mismatch",
    depth: "nested too deep",
  };
  const FIELD_TAGS = "spur-choice-list, spur-text-input, spur-textarea";
  const BOUND_SELECTOR =
    "[data-spur-action], spur-button, spur-choice-list, spur-choice, spur-text-input, spur-textarea";
  const SPINNER =
    '<svg class="spur-spin" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg>';

  const boot = window.__SPUR_SNIPPET_BOOT__;
  let port = null;
  let context = null;
  let action = null;
  let availability = { canInvoke: true, reason: null };
  let rejection = null;
  let invokingEl = null;
  const listeners = { action: [], theme: [], fullscreen: [], availability: [] };
  const calls = new Map();
  let callCounter = 0;
  let appState = null;
  let stateTimer = null;
  let lastHeight = null;
  let resizeFrame = 0;
  let readyResolve = null;
  const readyPromise = new Promise(function (resolve) {
    readyResolve = resolve;
  });
  const encoder = new TextEncoder();

  // ---------------------------------------------------------------- helpers

  function byteLength(value) {
    return encoder.encode(JSON.stringify(value)).length;
  }

  function emit(name, data) {
    listeners[name].slice().forEach(function (handler) {
      handler(data);
    });
  }

  function post(message) {
    if (port) port.postMessage(message);
  }

  function isTerminal(status) {
    return TERMINAL.indexOf(status) >= 0;
  }

  function isBusy() {
    return action !== null && !isTerminal(action.status);
  }

  function formatRejection(result) {
    const text = REJECTION_TEXT[result.reason] || "Action rejected.";
    if (result.reason !== "invalid_payload" || !result.issues || result.issues.length === 0) {
      return text;
    }
    return [text]
      .concat(
        result.issues.map(function (issue) {
          return (issue.path || "/") + " " + (ISSUE_WORDS[issue.code] || issue.code);
        }),
      )
      .join("\n");
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function whenParsed(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  // --------------------------------------------------------------- styles

  const STYLE = [
    "html{height:auto}",
    "html,body{background:transparent;color:var(--spur-text-primary);font-family:var(--spur-font);font-size:12px;letter-spacing:.02em}",
    "*{box-sizing:border-box}",
    "body{margin:0;padding:12px;display:flex;flex-direction:column;gap:12px}",
    "spur-form{display:flex;flex-direction:column;gap:8px}",
    ".spur-list-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:var(--spur-text-tertiary);display:flex;gap:8px;align-items:center}",
    ".spur-list-label i{flex:1;border-top:1px solid var(--spur-border-subtle)}",
    "spur-choice-list{display:flex;flex-direction:column;border:1px solid var(--spur-border-default)}",
    "spur-choice{position:relative;display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-bottom:1px solid var(--spur-border-subtle);line-height:1.5;color:var(--spur-text-secondary);cursor:pointer}",
    "spur-choice:last-child{border-bottom:0}",
    "spur-choice[aria-selected=true]{background:color-mix(in srgb,var(--spur-accent) 6%,transparent);color:var(--spur-text-primary);box-shadow:inset 2px 0 0 var(--spur-accent)}",
    "spur-choice[disabled]{opacity:.55;cursor:not-allowed}",
    "spur-choice:focus-visible,.spur-btn:focus-visible,.spur-field input:focus-visible,.spur-field textarea:focus-visible{outline:2px solid var(--spur-accent);outline-offset:-2px}",
    ".spur-choice-box{width:14px;height:14px;border:1px solid var(--spur-border-default);flex-shrink:0;margin-top:2px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:var(--spur-text-inverse)}",
    "spur-choice[aria-selected=true] .spur-choice-box{background:var(--spur-accent);border-color:var(--spur-accent)}",
    "spur-choice[aria-selected=true] .spur-choice-box::after{content:'';width:7px;height:4px;margin-top:-2px;border-left:1.5px solid var(--spur-text-inverse);border-bottom:1.5px solid var(--spur-text-inverse);transform:rotate(-45deg)}",
    "spur-choice-list[aria-invalid=true]{border-color:var(--spur-status-error)}",
    "spur-selectable-text{display:block;flex:1;line-height:1.5}",
    "spur-selectable-text::selection{background:color-mix(in srgb,var(--spur-status-working) 35%,transparent);color:var(--spur-text-primary)}",
    "spur-selection-toolbar{position:absolute;display:none;gap:6px;align-items:center;background:var(--spur-bg-elevated);border:1px solid var(--spur-border-default);padding:4px;z-index:2}",
    "spur-selection-toolbar[data-visible]{display:flex}",
    ".spur-toolbar-count{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--spur-text-tertiary);padding:0 4px}",
    ".spur-field{display:flex;flex-direction:column;gap:6px}",
    ".spur-field-label{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--spur-text-tertiary);display:flex;justify-content:space-between}",
    ".spur-field input,.spur-field textarea{font:inherit;letter-spacing:inherit;color:var(--spur-text-primary);background:var(--spur-input-bg);border:1px solid var(--spur-input-border);padding:6px 8px;width:100%;line-height:1.5;border-radius:0}",
    ".spur-field textarea{resize:none}",
    ".spur-field [aria-invalid=true]{border-color:var(--spur-status-error)}",
    ".spur-field input:disabled,.spur-field textarea:disabled{opacity:.55}",
    ".spur-field-error{color:var(--spur-status-error);font-size:11px}",
    ".spur-btn{font:inherit;letter-spacing:inherit;font-weight:700;text-transform:uppercase;padding:6px 12px;border:1px solid var(--spur-border-default);background:transparent;color:var(--spur-text-primary);display:inline-flex;gap:6px;align-items:center;cursor:pointer;border-radius:0}",
    "spur-button{display:inline-flex}",
    "spur-button[variant=primary] .spur-btn{background:var(--spur-accent);color:var(--spur-text-inverse);border-color:var(--spur-accent)}",
    "spur-button[variant=danger] .spur-btn{border-color:var(--spur-status-error);color:var(--spur-status-error)}",
    ".spur-btn:disabled{opacity:.5;cursor:not-allowed}",
    "spur-button[aria-busy=true] .spur-btn{opacity:1}",
    ".spur-spin{width:12px;height:12px;animation:spur-rotate .9s linear infinite}",
    "@keyframes spur-rotate{to{transform:rotate(360deg)}}",
    "@media (prefers-reduced-motion:reduce){.spur-spin{animation-duration:2.4s}}",
    "spur-status{display:none;border:1px solid var(--spur-border-subtle);padding:6px 10px;flex-direction:column;gap:4px;color:var(--spur-text-secondary)}",
    "spur-status[data-active]{display:flex}",
    "spur-status[data-tone=error]{border-color:color-mix(in srgb,var(--spur-status-error) 40%,transparent)}",
    ".spur-status-head{display:flex;gap:8px;align-items:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--spur-text-primary)}",
    "spur-status[data-tone=error] .spur-status-head{color:var(--spur-status-error)}",
    ".spur-status-note{white-space:pre-line}",
    ".spur-status-head .spur-btn{margin-left:auto;padding:2px 10px;font-size:10px;letter-spacing:.12em}",
    "spur-loader{display:inline-flex;color:var(--spur-text-secondary)}",
    "spur-empty,spur-error{display:block;border:1px solid var(--spur-border-subtle);padding:8px 10px;color:var(--spur-text-secondary)}",
    "spur-error{border-color:color-mix(in srgb,var(--spur-status-error) 40%,transparent);color:var(--spur-status-error);white-space:pre-line}",
  ].join("\n");

  function installStyles() {
    const style = document.createElement("style");
    style.setAttribute("data-spur-sdk", "");
    style.textContent = STYLE;
    document.head.insertBefore(style, document.head.firstChild);
  }

  // ---------------------------------------------------- busy and availability

  function setDisabledMarker(node, disabled) {
    if (disabled) {
      if (!node.hasAttribute("disabled")) {
        node.setAttribute("disabled", "");
        node.setAttribute("data-spur-disabled", "");
      }
    } else if (node.hasAttribute("data-spur-disabled")) {
      node.removeAttribute("disabled");
      node.removeAttribute("data-spur-disabled");
    }
  }

  // Controls only. The mutation observer calls this; spur-status renders in
  // refreshControls, so its own DOM writes cannot re-trigger the observer.
  function applyControlState() {
    const busy = isBusy();
    const blocked = busy || !availability.canInvoke;
    document.querySelectorAll(BOUND_SELECTOR).forEach(function (node) {
      setDisabledMarker(node, blocked);
      if (busy) node.setAttribute("aria-busy", "true");
      else node.removeAttribute("aria-busy");
      if (node.tagName === "SPUR-BUTTON" && typeof node.syncSpinner === "function") {
        node.syncSpinner(busy && node === invokingEl);
      }
    });
  }

  function refreshControls() {
    applyControlState();
    document.querySelectorAll("spur-status").forEach(function (node) {
      if (typeof node.render === "function") node.render();
    });
  }

  // ----------------------------------------------------------------- invoke

  function nextCallId() {
    callCounter += 1;
    return "c" + callCounter;
  }

  function request(message) {
    return new Promise(function (resolve) {
      const callId = nextCallId();
      calls.set(callId, resolve);
      message.callId = callId;
      post(message);
    });
  }

  function invalidFieldPaths(issues) {
    const names = {};
    (issues || []).forEach(function (issue) {
      const name = String(issue.path || "").split("/")[1];
      if (name)
        names[name] =
          (names[name] ? names[name] + ", " : "") + (ISSUE_WORDS[issue.code] || issue.code);
    });
    return names;
  }

  function clearFieldIssues() {
    document.querySelectorAll(FIELD_TAGS).forEach(function (node) {
      if (typeof node.setIssue === "function") node.setIssue(null);
    });
  }

  function showRejection(result) {
    rejection = result;
    clearFieldIssues();
    if (result.reason === "invalid_payload") {
      const names = invalidFieldPaths(result.issues);
      document.querySelectorAll(FIELD_TAGS).forEach(function (node) {
        const name = node.getAttribute("name");
        if (name && names[name] !== undefined) node.setIssue(names[name]);
      });
    }
    updateFallback(true);
    refreshControls();
  }

  function updateFallback(show) {
    const existing = document.querySelector("[data-spur-fallback]");
    const hasStatus = document.querySelector("spur-status") !== null;
    if (!show || rejection === null || hasStatus) {
      if (existing) existing.remove();
      return;
    }
    const node = existing || document.createElement("spur-error");
    node.setAttribute("data-spur-fallback", "");
    node.setAttribute("role", "alert");
    node.textContent = formatRejection(rejection);
    if (!existing || document.body.lastElementChild !== node) document.body.appendChild(node);
  }

  function clearRejection() {
    rejection = null;
    clearFieldIssues();
    updateFallback(false);
  }

  function setAction(next) {
    action = next;
    emit("action", next);
    refreshControls();
  }

  function invoke(actionId, payload, retryOf) {
    if (!port) return Promise.resolve({ ok: false, reason: "not_connected" });
    const before = action;
    const message = { type: MSG.invoke, actionId: actionId };
    if (payload !== undefined) message.payload = payload;
    if (retryOf) message.retryOf = retryOf;
    return request(message).then(function (result) {
      if (result.ok) {
        clearRejection();
      } else {
        if (action && action.status === "awaiting_confirm") {
          action = before;
          if (before) emit("action", before);
        }
        showRejection(result);
      }
      return result.ok ? { ok: true, requestId: result.requestId } : result;
    });
  }

  function setInvokingEl(node) {
    invokingEl = node;
  }

  function retry() {
    if (!action || RETRYABLE.indexOf(action.status) < 0) {
      return Promise.resolve({ ok: false, reason: "busy" });
    }
    return invoke(action.actionId, undefined, action.requestId);
  }

  // ------------------------------------------------------------------ state

  function collectControls() {
    const controls = [];
    document.querySelectorAll(FIELD_TAGS).forEach(function (node) {
      const id = node.getAttribute("id");
      if (id) controls.push({ id: id, value: node.value });
    });
    return controls;
  }

  function scheduleStateSend() {
    if (!port || stateTimer !== null) return;
    stateTimer = setTimeout(function () {
      stateTimer = null;
      post({
        type: MSG.stateSet,
        callId: nextCallId(),
        app: appState,
        controls: collectControls(),
      });
    }, STATE_WINDOW_MS);
  }

  function noteControlChange(node) {
    if (node.getAttribute("id")) scheduleStateSend();
    if (node.hasAttribute("aria-invalid") && typeof node.setIssue === "function")
      node.setIssue(null);
  }

  // ----------------------------------------------------------- selection

  function selectionFromDocument(sourceId) {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const start = range.startContainer;
    const source = (start.nodeType === 1 ? start : start.parentElement).closest(
      "spur-selectable-text",
    );
    if (!source || !source.contains(range.endContainer)) return null;
    const id = source.getAttribute("source-id");
    if (!id || (sourceId !== undefined && sourceId !== id)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(source);
    pre.setEnd(range.startContainer, range.startOffset);
    const text = source.textContent || "";
    const from = pre.toString().length;
    const to = from + range.toString().length;
    if (to <= from || to > text.length) return null;
    return { sourceId: id, text: text, start: from, end: to, quote: text.slice(from, to) };
  }

  // --------------------------------------------------------------- public API

  const sdk = {
    protocolVersion: PROTOCOL_VERSION,
    ready: function () {
      return readyPromise;
    },
    invoke: function (actionId, payload) {
      return invoke(actionId, payload);
    },
    retry: retry,
    on: function (event, handler) {
      listeners[event].push(handler);
      return function () {
        const index = listeners[event].indexOf(handler);
        if (index >= 0) listeners[event].splice(index, 1);
      };
    },
    once: function (event, handler) {
      const off = sdk.on(event, function (data) {
        off();
        handler(data);
      });
      return off;
    },
    state: {
      get: function () {
        return appState;
      },
      set: function (value) {
        if (byteLength(value) > STATE_MAX_BYTES) throw new RangeError("snippet state over 64 KiB");
        appState = value;
        scheduleStateSend();
      },
    },
    requestFullscreen: function () {
      if (!port) return Promise.resolve(false);
      return request({ type: MSG.fullscreen, open: true });
    },
    exitFullscreen: function () {
      post({ type: MSG.fullscreen, open: false });
    },
    selection: function (sourceId) {
      return selectionFromDocument(sourceId);
    },
  };
  Object.defineProperty(sdk, "action", {
    get: function () {
      return action;
    },
    enumerable: true,
  });
  Object.defineProperty(sdk, "formatRejection", { value: formatRejection });
  window.spur = sdk;

  // -------------------------------------------------------------- port + host

  function applyTheme(theme) {
    const root = document.documentElement;
    // Without it Chromium paints an opaque light canvas under a dark host.
    root.style.colorScheme = theme.mode;
    Object.keys(theme.tokens).forEach(function (token) {
      root.style.setProperty("--spur-" + token, theme.tokens[token]);
    });
  }

  function registerFonts(fonts) {
    let added = false;
    fonts.forEach(function (font) {
      const face = new FontFace(font.family, font.data, { weight: font.weight });
      document.fonts.add(face);
      face.load().catch(function () {});
      added = true;
    });
    if (added) {
      document.documentElement.style.setProperty(
        "--spur-font",
        '"Spur Mono", "JetBrains Mono", "SF Mono", "Menlo", "Consolas", monospace',
      );
    }
  }

  function restoreControls(saved) {
    whenParsed(function () {
      saved.forEach(function (entry) {
        const node = document.getElementById(entry.id);
        if (node && typeof node.restore === "function") node.restore(entry.value);
      });
    });
  }

  function onPortMessage(event) {
    const data = event.data;
    if (!data || typeof data.type !== "string") return;
    switch (data.type) {
      case MSG.invokeResult:
      case MSG.stateAck: {
        const resolve = calls.get(data.callId);
        if (resolve) {
          calls.delete(data.callId);
          resolve(data);
        }
        return;
      }
      case MSG.action:
        setAction(data.action);
        return;
      case MSG.theme:
        context.theme = data.theme;
        applyTheme(data.theme);
        emit("theme", data.theme);
        return;
      case MSG.availability:
        availability = data.availability;
        refreshControls();
        emit("availability", availability);
        return;
      case MSG.fullscreen: {
        if (typeof data.callId === "string") {
          const pending = calls.get(data.callId);
          if (pending) {
            calls.delete(data.callId);
            pending(data.granted === true);
          }
        }
        if (context && context.fullscreen !== data.fullscreen) {
          context.fullscreen = data.fullscreen;
          emit("fullscreen", { fullscreen: data.fullscreen });
        }
        return;
      }
      default:
    }
  }

  function reportHeight() {
    resizeFrame = 0;
    if (!port) return;
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    post({ type: MSG.resize, height: height });
  }

  function scheduleHeight() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(reportHeight);
  }

  function onConnect(event) {
    const data = event.data;
    if (port || event.source !== window.parent) return;
    if (!data || data.type !== MSG.connect || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    context = data.context;
    availability = context.availability;
    action = context.action;
    appState = context.state;
    port.onmessage = onPortMessage;
    applyTheme(context.theme);
    if (context.fonts) registerFonts(context.fonts);
    new ResizeObserver(scheduleHeight).observe(document.documentElement);
    whenParsed(function () {
      scheduleHeight();
      refreshControls();
    });
    restoreControls(context.controls || []);
    document.addEventListener("keydown", function (keyEvent) {
      if (keyEvent.key === "Escape" && context.fullscreen) post({ type: MSG.escape });
    });
    readyResolve(context);
  }

  window.addEventListener("message", onConnect);

  let hellos = 0;
  function hello() {
    if (port || hellos >= HELLO_MAX) return;
    hellos += 1;
    window.parent.postMessage(
      { type: MSG.hello, protocolVersion: PROTOCOL_VERSION, nonce: boot.nonce },
      "*",
    );
    setTimeout(hello, HELLO_INTERVAL_MS);
  }

  installStyles();
  new MutationObserver(function () {
    queueMicrotask(function () {
      applyControlState();
      scheduleHeight();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  hello();

  // ----------------------------------------------------------------- library

  function gatherForm(formEl) {
    const payload = {};
    formEl.querySelectorAll(FIELD_TAGS).forEach(function (node) {
      const name = node.getAttribute("name");
      if (!name) return;
      const value = node.value;
      if (value === "" || value === null) return;
      payload[name] = value;
    });
    return payload;
  }

  function parseJsonObject(text) {
    if (!text) return {};
    try {
      const value = JSON.parse(text);
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function define(name, ctor) {
    if (!customElements.get(name)) customElements.define(name, ctor);
  }

  // Field base: label, control, issue message.
  function mountField(host, labelText, control, withCounter, max) {
    const wrap = el("div", "spur-field");
    const head = el("div", "spur-field-label");
    const label = el("span", "", labelText || "");
    head.appendChild(label);
    let counter = null;
    if (withCounter) {
      counter = el("span", "", "");
      head.appendChild(counter);
    }
    if (labelText) wrap.appendChild(head);
    wrap.appendChild(control);
    const message = el("div", "spur-field-error");
    message.hidden = true;
    wrap.appendChild(message);
    host.appendChild(wrap);
    function updateCounter() {
      if (counter) counter.textContent = control.value.length + (max ? " / " + max : "");
    }
    updateCounter();
    return { message: message, updateCounter: updateCounter };
  }

  let fieldSeq = 0;

  function defineTextField(tag, controlTag) {
    define(
      tag,
      class extends HTMLElement {
        connectedCallback() {
          whenParsed(() => {
            if (this._ready) return;
            this._ready = true;
            const control = document.createElement(controlTag);
            if (controlTag === "input") control.type = "text";
            if (controlTag === "textarea") control.rows = Number(this.getAttribute("rows")) || 3;
            const max = Number(this.getAttribute("maxlength")) || 0;
            if (max) control.maxLength = max;
            if (this.hasAttribute("placeholder"))
              control.placeholder = this.getAttribute("placeholder");
            fieldSeq += 1;
            const messageId = "spur-field-msg-" + fieldSeq;
            const parts = mountField(
              this,
              this.getAttribute("label"),
              control,
              controlTag === "textarea",
              max,
            );
            parts.message.id = messageId;
            this._control = control;
            this._updateCounter = parts.updateCounter;
            this._message = parts.message;
            this._messageId = messageId;
            control.addEventListener("input", () => {
              parts.updateCounter();
              noteControlChange(this);
              this.dispatchEvent(new CustomEvent("change"));
            });
            if (controlTag === "input") {
              control.addEventListener("keydown", (keyEvent) => {
                if (keyEvent.key !== "Enter") return;
                const form = this.closest("spur-form");
                if (form) form.submit();
              });
            }
            this.syncDisabled();
          });
        }
        static get observedAttributes() {
          return ["disabled"];
        }
        attributeChangedCallback() {
          this.syncDisabled();
        }
        syncDisabled() {
          if (this._control) this._control.disabled = this.hasAttribute("disabled");
        }
        get value() {
          return this._control ? this._control.value : "";
        }
        set value(next) {
          if (this._control) this._control.value = String(next);
        }
        restore(value) {
          if (typeof value === "string" && this._control) {
            this._control.value = value;
            this._updateCounter();
          }
        }
        setIssue(text) {
          if (!this._control) return;
          if (text === null) {
            this._control.removeAttribute("aria-invalid");
            this._control.removeAttribute("aria-describedby");
            this._message.hidden = true;
            this._message.textContent = "";
            this.removeAttribute("aria-invalid");
            return;
          }
          this.setAttribute("aria-invalid", "true");
          this._control.setAttribute("aria-invalid", "true");
          this._control.setAttribute("aria-describedby", this._messageId);
          this._message.textContent = text;
          this._message.hidden = false;
        }
      },
    );
  }

  defineTextField("spur-text-input", "input");
  defineTextField("spur-textarea", "textarea");

  define(
    "spur-choice",
    class extends HTMLElement {
      connectedCallback() {
        whenParsed(() => {
          if (this._ready) return;
          this._ready = true;
          this.setAttribute("role", "option");
          this.setAttribute("tabindex", "0");
          if (!this.hasAttribute("aria-selected")) this.setAttribute("aria-selected", "false");
          const box = el("span", "spur-choice-box");
          box.setAttribute("aria-hidden", "true");
          this.insertBefore(box, this.firstChild);
          this.addEventListener("click", () => {
            if (this.hasAttribute("disabled")) return;
            const list = this.closest("spur-choice-list");
            if (list) list.toggle(this);
          });
          this.addEventListener("keydown", (keyEvent) => {
            if (keyEvent.key !== " " && keyEvent.key !== "Enter") return;
            keyEvent.preventDefault();
            this.click();
          });
        });
      }
      get value() {
        return this.getAttribute("value") || "";
      }
    },
  );

  define(
    "spur-choice-list",
    class extends HTMLElement {
      connectedCallback() {
        this.setAttribute("role", "listbox");
        if (this.getAttribute("mode") === "multiple")
          this.setAttribute("aria-multiselectable", "true");
        whenParsed(() => {
          const text = this.getAttribute("label");
          if (!text || this._head) return;
          this.setAttribute("aria-label", text);
          const head = el("div", "spur-list-label");
          head.setAttribute("aria-hidden", "true");
          head.appendChild(el("span", "", text));
          head.appendChild(el("i", ""));
          this._count = el("span", "");
          head.appendChild(this._count);
          this._head = head;
          this.parentNode.insertBefore(head, this);
          this.updateCount();
        });
      }
      updateCount() {
        if (!this._count) return;
        const picked = this.choices().filter(function (choice) {
          return choice.getAttribute("aria-selected") === "true";
        }).length;
        this._count.textContent = picked + " of " + this.choices().length + " selected";
      }
      choices() {
        return Array.from(this.querySelectorAll("spur-choice"));
      }
      toggle(choice) {
        const multiple = this.getAttribute("mode") === "multiple";
        const selected = choice.getAttribute("aria-selected") === "true";
        if (!multiple) {
          this.choices().forEach(function (other) {
            other.setAttribute("aria-selected", "false");
          });
          choice.setAttribute("aria-selected", selected ? "false" : "true");
        } else {
          choice.setAttribute("aria-selected", selected ? "false" : "true");
        }
        this.updateCount();
        noteControlChange(this);
        this.dispatchEvent(new CustomEvent("change"));
      }
      get value() {
        const picked = this.choices()
          .filter(function (choice) {
            return choice.getAttribute("aria-selected") === "true";
          })
          .map(function (choice) {
            return choice.value;
          });
        if (this.getAttribute("mode") === "multiple") return picked;
        return picked.length > 0 ? picked[0] : null;
      }
      set value(next) {
        const wanted = Array.isArray(next) ? next : next === null ? [] : [next];
        this.choices().forEach(function (choice) {
          choice.setAttribute(
            "aria-selected",
            wanted.indexOf(choice.value) >= 0 ? "true" : "false",
          );
        });
        this.updateCount();
      }
      restore(value) {
        const known = this.choices().map(function (choice) {
          return choice.value;
        });
        const wanted = Array.isArray(value) ? value : value === null ? [] : [value];
        const kept = wanted.filter(function (item) {
          return known.indexOf(item) >= 0;
        });
        if (kept.length !== wanted.length) return;
        this.value = this.getAttribute("mode") === "multiple" ? kept : kept.length ? kept[0] : null;
        this.dispatchEvent(new CustomEvent("change"));
      }
      setIssue(text) {
        if (text === null) this.removeAttribute("aria-invalid");
        else this.setAttribute("aria-invalid", "true");
      }
    },
  );

  define(
    "spur-selectable-text",
    class extends HTMLElement {
      connectedCallback() {
        this.setAttribute("tabindex", "-1");
      }
    },
  );

  define(
    "spur-selection-toolbar",
    class extends HTMLElement {
      connectedCallback() {
        whenParsed(() => {
          if (this._ready) return;
          this._ready = true;
          this._count = el("span", "spur-toolbar-count", "");
          this.insertBefore(this._count, this.firstChild);
          this.addEventListener("mousedown", function (mouseEvent) {
            mouseEvent.preventDefault();
          });
          document.addEventListener("selectionchange", () => {
            this.update();
          });
        });
      }
      get field() {
        return this.getAttribute("field") || "selection";
      }
      get current() {
        return this._selection || null;
      }
      update() {
        const ids = (this.getAttribute("for") || "").split(/\s+/).filter(Boolean);
        const found = selectionFromDocument();
        if (!found || ids.indexOf(found.sourceId) < 0) {
          if (!this._selection || !this.contains(document.activeElement)) {
            this._selection = null;
            this.removeAttribute("data-visible");
          }
          return;
        }
        this._selection = found;
        this._count.textContent = found.end - found.start + " chars";
        const rect = document.getSelection().getRangeAt(0).getBoundingClientRect();
        this.setAttribute("data-visible", "");
        this.style.top = Math.max(0, rect.top + window.scrollY - this.offsetHeight - 4) + "px";
        this.style.left = Math.max(0, rect.left + window.scrollX) + "px";
      }
    },
  );

  define(
    "spur-button",
    class extends HTMLElement {
      static get observedAttributes() {
        return ["disabled", "aria-busy"];
      }
      connectedCallback() {
        whenParsed(() => {
          if (this._ready) return;
          this._ready = true;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "spur-btn";
          while (this.firstChild) button.appendChild(this.firstChild);
          this.appendChild(button);
          this._button = button;
          button.addEventListener("click", () => {
            this.press();
          });
          this.syncDisabled();
        });
      }
      attributeChangedCallback() {
        this.syncDisabled();
      }
      syncDisabled() {
        if (!this._button) return;
        this._button.disabled = this.hasAttribute("disabled");
        if (this.hasAttribute("aria-busy")) this._button.setAttribute("aria-busy", "true");
        else this._button.removeAttribute("aria-busy");
      }
      syncSpinner(show) {
        if (!this._button) return;
        const existing = this._button.querySelector(".spur-spin");
        if (show && !existing) this._button.insertAdjacentHTML("afterbegin", SPINNER);
        if (!show && existing) existing.remove();
      }
      press() {
        if (this.hasAttribute("disabled")) return;
        const toolbar = this.closest("spur-selection-toolbar");
        const form = this.getAttribute("form")
          ? document.getElementById(this.getAttribute("form"))
          : this.closest("spur-form");
        const payload = parseJsonObject(this.getAttribute("payload"));
        if (form && typeof form.collect === "function") Object.assign(payload, form.collect());
        if (toolbar) {
          const picked = toolbar.current || selectionFromDocument();
          if (picked) payload[toolbar.field] = picked;
        }
        const id = this.getAttribute("action") || (form && form.getAttribute("action"));
        if (!id) return;
        setInvokingEl(this);
        invoke(id, payload);
      }
    },
  );

  define(
    "spur-form",
    class extends HTMLElement {
      collect() {
        return gatherForm(this);
      }
      submit() {
        const id = this.getAttribute("action");
        if (!id || this.hasAttribute("disabled")) return;
        invokingEl = this.querySelector('spur-button[type="submit"]');
        invoke(id, this.collect());
      }
    },
  );

  define(
    "spur-status",
    class extends HTMLElement {
      connectedCallback() {
        whenParsed(() => {
          this.render();
        });
        this.addEventListener("click", function (clickEvent) {
          if (clickEvent.target.closest && clickEvent.target.closest("[data-spur-retry]")) retry();
        });
      }
      render() {
        if (!this.isConnected) return;
        this.textContent = "";
        let tone = "";
        const head = el("div", "spur-status-head");
        if (rejection !== null) {
          tone = "error";
          head.appendChild(el("span", "", "Not sent"));
          this.appendChild(head);
          this.appendChild(el("div", "spur-status-note", formatRejection(rejection)));
        } else if (action !== null) {
          const status = action.status;
          if (!isTerminal(status)) head.insertAdjacentHTML("beforeend", SPINNER);
          let label = STATUS_LABELS[status] || status;
          if (status === "error" && action.httpStatus !== undefined)
            label += " · HTTP " + action.httpStatus;
          if (status === "error" || status === "delivery_unknown") tone = "error";
          head.appendChild(el("span", "", label));
          if (RETRYABLE.indexOf(status) >= 0) {
            const again = el("button", "spur-btn", "Retry");
            again.type = "button";
            again.setAttribute("data-spur-retry", "");
            head.appendChild(again);
          }
          this.appendChild(head);
          if (status === "error") {
            this.appendChild(
              el(
                "div",
                "spur-status-note",
                "Session refused the message. Retry sends a new request.",
              ),
            );
          }
          if (status === "timeout") {
            this.appendChild(
              el("div", "spur-status-note", "A late matching revision still completes the action."),
            );
          }
          if (status === "delivery_unknown") {
            this.appendChild(
              el("div", "spur-status-note", "Check Queued messages before retrying."),
            );
          }
        } else {
          this.removeAttribute("data-active");
          this.removeAttribute("data-tone");
          return;
        }
        this.setAttribute("data-active", "");
        if (tone) this.setAttribute("data-tone", tone);
        else this.removeAttribute("data-tone");
      }
    },
  );

  define(
    "spur-loader",
    class extends HTMLElement {
      connectedCallback() {
        this.setAttribute("role", "status");
        if (!this.hasAttribute("aria-label")) this.setAttribute("aria-label", "In progress");
        if (!this.querySelector("svg")) this.insertAdjacentHTML("afterbegin", SPINNER);
      }
    },
  );
  define("spur-empty", class extends HTMLElement {});
  define("spur-error", class extends HTMLElement {});

  // Elements with data-spur-action are clickable action triggers.
  document.addEventListener("click", function (clickEvent) {
    const target = clickEvent.target;
    const node = target && target.closest ? target.closest("[data-spur-action]") : null;
    if (!node || node.hasAttribute("disabled")) return;
    invokingEl = node;
    invoke(
      node.getAttribute("data-spur-action"),
      parseJsonObject(node.getAttribute("data-spur-payload")),
    );
  });
})();
