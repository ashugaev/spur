/* Spur SDK v2: one window.spur for pages and snippets, plus the generic component library.
 * Transport chosen once: a snippet frame (window.__SPUR_SNIPPET_BOOT__, SDK inlined by the
 * host) talks to the dashboard panel over a MessageChannel port; a page (/p/<id>/,
 * loaded as ./_spur/sdk.js) uses fetch plus one EventSource on ./_spur/events.
 * Port message strings mirror src/lib/snippets/snippet-protocol.ts (guarded by
 * src/__tests__/spur-sdk.test.ts). Colors come from --spur-<token> custom properties:
 * host theme tokens in snippets, CSS system colors in pages. User text renders via
 * textContent only. */
(function () {
  "use strict";
  if (window.__SPUR_SDK_BOOTED__) return;
  window.__SPUR_SDK_BOOTED__ = true;

  const MSG = {
    hello: "spur:hello",
    connect: "spur:connect",
    invoke: "invoke",
    stateSet: "state-set",
    db: "db",
    dbSubscribe: "db-subscribe",
    dbUnsubscribe: "db-unsubscribe",
    agent: "agent",
    fullscreen: "fullscreen",
    resize: "resize",
    escape: "escape",
    invokeResult: "invoke-result",
    action: "action",
    theme: "theme",
    availability: "availability",
    dbChange: "db-change",
    dbReset: "db-reset",
    agentEvent: "agent-event",
    chatRegister: "chat-register",
    chatFocus: "chat-focus",
    chatUnregister: "chat-unregister",
    chatTranscript: "chat-transcript",
  };
  const PROTOCOL_VERSION = 2;
  const HELLO_INTERVAL_MS = 200;
  const HELLO_MAX = 25;
  const STATE_WINDOW_MS = 500;
  const STATE_MAX_BYTES = 64 * 1024;
  const AGENT_POLL_MS = 2000;
  const TERMINAL = ["completed", "error", "timeout"];
  const RETRYABLE = ["error", "timeout"];
  const STATUS_LABELS = {
    awaiting_confirm: "Confirm to send",
    submitting: "Sent",
    queued: "Queued",
    processing: "Agent working",
    completed: "Done",
    error: "Send failed",
    timeout: "No reply in 15 min",
  };
  const AGENT_LABELS = {
    none: "Agent starts on first message",
    working: "Agent working",
    idle: "Agent idle",
    recovering: "Agent restarting",
    error: "Agent unavailable",
    rate_limited: "Agent rate limited",
  };
  const REJECTION_TEXT = {
    not_connected: "Not connected.",
    unknown_action: "Unknown action.",
    payload_too_large: "Payload is too large.",
    invalid_payload: "Invalid payload.",
    session_unavailable: "The agent is not accepting messages.",
    busy: "Another action is still in flight.",
    declined: "Action discarded.",
    stale: "Snippet was replaced before the action was sent.",
    failed: "The agent reported a failure.",
    timeout: "No reply in 15 min.",
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
  // Page defaults: CSS system colors, so a page follows the OS light/dark scheme.
  // Status tones and text-tertiary come from the page palette stylesheet (system colors like Mark or GrayText are unreadable as text).
  const PAGE_THEME = {
    "bg-base": "Canvas",
    "bg-surface": "Canvas",
    "bg-elevated": "Canvas",
    "text-primary": "CanvasText",
    "text-secondary": "CanvasText",
    "border-default": "GrayText",
    "border-subtle": "ButtonFace",
    accent: "AccentColor",
    "input-bg": "Field",
    "input-border": "GrayText",
    "text-inverse": "AccentColorText",
  };
  const pageMatch = /^\/p\/([a-z0-9][a-z0-9-]{0,39})(?:\/|$)/.exec(window.location.pathname);
  const pageRoot = pageMatch ? "/p/" + pageMatch[1] + "/" : null;
  const PAGE_PALETTE_HREF = pageRoot + "_spur/theme.css";
  const chats = new Map();
  const FIELD_TAGS = "spur-choice-list, spur-text-input, spur-textarea";
  const BOUND_SELECTOR =
    "[data-spur-action], spur-button, spur-choice-list, spur-choice, spur-text-input, spur-textarea";
  const SPINNER =
    '<svg class="spur-spin" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg>';

  const boot = window.__SPUR_SNIPPET_BOOT__;
  let context = null;
  let action = null;
  let availability = { canInvoke: true, reason: null };
  let rejection = null;
  let invokingEl = null;
  let agentStatus = { state: "none", sessionId: null };
  const listeners = {
    action: [],
    theme: [],
    fullscreen: [],
    availability: [],
    agent: [],
    message: [],
  };
  let appState = null;
  let stateTimer = null;
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

  function isTerminal(status) {
    return TERMINAL.indexOf(status) >= 0;
  }

  function isBusy() {
    return action !== null && !isTerminal(action.status);
  }

  // Every agent status source (connect context, stream event, poll, status()) lands here.
  function setAgentStatus(next) {
    const changed = next.state !== agentStatus.state || next.sessionId !== agentStatus.sessionId;
    agentStatus = next;
    if (changed) emit("agent", agentStatus);
  }

  function formatRejection(result) {
    if (result.reason === "failed" && result.error) return String(result.error);
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

  function randomId() {
    const bytes = new Uint8Array(10);
    window.crypto.getRandomValues(bytes);
    return (
      "act-" +
      Array.from(bytes)
        .map(function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  function encodeSegment(value) {
    return encodeURIComponent(String(value));
  }

  // ----------------------------------------------------------------- transports
  // Shared interface:
  //   connect() -> Promise<context>  {dataStore, agentStore, state, controls, theme?, ...}
  //   db(method, path, body) -> Promise<{ok, status, body}>   path relative to the data store
  //   agent(op, args) -> Promise<{ok, status, body}>          send | messages | status
  //   invoke(request) -> Promise<result>                      final resolution shape
  //   stateSave(app, controls) -> void
  //   subscribe(store) / unsubscribe(store)                   change feed for onSnapshot
  //   requestFullscreen(open) -> Promise<boolean>
  // Events arrive through `onTransportEvent`.

  function onTransportEvent(event) {
    switch (event.type) {
      case "change":
        dispatchChange(event.change);
        return;
      case "reset":
        refreshSnapshots();
        return;
      case "reload":
        window.location.reload();
        return;
      case "agent":
        setAgentStatus(event.status);
        return;
      default:
    }
  }

  function createPortTransport() {
    let port = null;
    const calls = new Map();
    let callCounter = 0;
    let lastHeight = null;
    let resizeFrame = 0;

    function post(message) {
      if (port) port.postMessage(message);
    }

    function request(message) {
      return new Promise(function (resolve) {
        callCounter += 1;
        const callId = "c" + callCounter;
        calls.set(callId, resolve);
        message.callId = callId;
        post(message);
      });
    }

    function onPortMessage(event) {
      const data = event.data;
      if (!data || typeof data.type !== "string") return;
      if (typeof data.callId === "string" && calls.has(data.callId)) {
        const resolve = calls.get(data.callId);
        calls.delete(data.callId);
        resolve(data);
        if (data.type !== MSG.fullscreen) return;
      }
      switch (data.type) {
        case MSG.chatTranscript:
          if (
            typeof data.target === "string" &&
            typeof data.text === "string" &&
            data.text.length <= 20000
          ) {
            const chat = chats.get(data.target);
            if (chat) chat.insertTranscript(data.text);
          }
          return;
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
        case MSG.fullscreen:
          if (context && context.fullscreen !== data.fullscreen) {
            context.fullscreen = data.fullscreen;
            emit("fullscreen", { fullscreen: data.fullscreen });
          }
          return;
        case MSG.dbChange:
          onTransportEvent({ type: "change", change: data.change });
          return;
        case MSG.dbReset:
          onTransportEvent({ type: "reset" });
          return;
        case MSG.agentEvent:
          onTransportEvent({ type: "agent", status: data.status });
          return;
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

    function connect() {
      return new Promise(function (resolve) {
        function onConnect(event) {
          const data = event.data;
          if (port || event.source !== window.parent) return;
          if (!data || data.type !== MSG.connect || !event.ports || !event.ports[0]) return;
          port = event.ports[0];
          port.onmessage = onPortMessage;
          const ctx = data.context;
          if (ctx.fonts) registerFonts(ctx.fonts);
          new ResizeObserver(scheduleHeight).observe(document.documentElement);
          new MutationObserver(function () {
            queueMicrotask(scheduleHeight);
          }).observe(document.documentElement, { childList: true, subtree: true });
          whenParsed(scheduleHeight);
          document.addEventListener("keydown", function (keyEvent) {
            if (keyEvent.key === "Escape" && context && context.fullscreen) {
              post({ type: MSG.escape });
            }
          });
          resolve(ctx);
        }
        window.addEventListener("message", onConnect);
        let hellos = 0;
        (function hello() {
          if (port || hellos >= HELLO_MAX) return;
          hellos += 1;
          window.parent.postMessage(
            { type: MSG.hello, protocolVersion: PROTOCOL_VERSION, nonce: boot.nonce },
            "*",
          );
          setTimeout(hello, HELLO_INTERVAL_MS);
        })();
      });
    }

    return {
      kind: "port",
      chatTarget: function (type, target) {
        post({ type: type, target: target });
      },
      connect: connect,
      connected: function () {
        return port !== null;
      },
      db: function (method, path, body) {
        const message = { type: MSG.db, method: method, path: path };
        if (body !== undefined) message.body = body;
        return request(message);
      },
      agent: function (op, args) {
        return request(Object.assign({ type: MSG.agent, op: op }, args || {}));
      },
      invoke: function (req) {
        const message = { type: MSG.invoke, action: req.action, payload: req.payload };
        if (req.retry) message.retry = true;
        if (req.trusted) message.trusted = true;
        return request(message).then(function (result) {
          const out = Object.assign({}, result);
          delete out.type;
          delete out.callId;
          return out;
        });
      },
      stateSave: function (app, controls) {
        post({ type: MSG.stateSet, app: app, controls: controls });
      },
      subscribe: function (store) {
        post({ type: MSG.dbSubscribe, store: store });
      },
      unsubscribe: function (store) {
        post({ type: MSG.dbUnsubscribe, store: store });
      },
      requestFullscreen: function (open) {
        if (!open) {
          post({ type: MSG.fullscreen, open: false });
          return Promise.resolve(false);
        }
        return request({ type: MSG.fullscreen, open: true }).then(function (data) {
          return data.granted === true;
        });
      },
    };
  }

  function createPageTransport() {
    if (!pageRoot) throw new Error("Page SDK requires a /p/<id>/ URL");
    const base = pageRoot + "_spur/";
    let source = null;
    const waiters = new Map();

    function call(method, path, body) {
      const init = { method: method, headers: { accept: "application/json" } };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      return window.fetch(base + path, init).then(
        function (response) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (json) {
              return { ok: response.ok, status: response.status, body: json };
            });
        },
        function () {
          return { ok: false, status: 0, body: { error: "network error" } };
        },
      );
    }

    function readAction(id) {
      return call("GET", "db/docs/_actions/" + encodeSegment(id));
    }

    // A malformed stream frame is dropped, never thrown into the EventSource handler.
    function parseEventData(event) {
      try {
        const data = JSON.parse(event.data);
        return data !== null && typeof data === "object" ? data : null;
      } catch {
        return null;
      }
    }

    function settleIfClosed(id) {
      const waiter = waiters.get(id);
      if (!waiter) return;
      readAction(id).then(function (response) {
        if (!response.ok || !waiters.has(id)) return;
        const doc = response.body;
        setAction(actionEventFromDoc(doc));
        const result = resultFromDoc(doc);
        if (result) {
          waiters.delete(id);
          waiter(result);
        }
      });
    }

    function reconcile() {
      waiters.forEach(function (_waiter, id) {
        settleIfClosed(id);
      });
      onTransportEvent({ type: "reset" });
    }

    return {
      kind: "page",
      connect: function () {
        source = new window.EventSource(base + "events");
        source.addEventListener("open", reconcile);
        source.addEventListener("change", function (event) {
          const change = parseEventData(event);
          if (!change) return;
          if (change.collection === "_actions") settleIfClosed(change.id);
          onTransportEvent({ type: "change", change: change });
        });
        source.addEventListener("reset", reconcile);
        source.addEventListener("reload", function () {
          onTransportEvent({ type: "reload" });
        });
        source.addEventListener("agent", function (event) {
          const status = parseEventData(event);
          if (status) onTransportEvent({ type: "agent", status: status });
        });
        applyTheme({ mode: null, tokens: PAGE_THEME });
        const palette = document.createElement("link");
        palette.rel = "stylesheet";
        palette.href = PAGE_PALETTE_HREF;
        palette.setAttribute("data-spur-sdk-palette", "");
        (document.head || document.documentElement).appendChild(palette);
        return call("GET", "db/docs/_state/page").then(function (response) {
          const stored = response.ok ? response.body.data : null;
          return {
            dataStore: "page",
            agentStore: "page",
            state: stored ? stored.app : null,
            controls: stored && Array.isArray(stored.controls) ? stored.controls : [],
            fullscreen: false,
          };
        });
      },
      connected: function () {
        return source !== null;
      },
      db: function (method, path, body) {
        return call(method, "db/" + path, body);
      },
      agent: function (op, args) {
        if (op === "send") return call("POST", "agent/send", args);
        const from = args && args.from !== undefined ? "?from=" + encodeSegment(args.from) : "";
        return call("GET", "agent/" + op + from);
      },
      invoke: function (req) {
        const previous = req.retry ? action : null;
        if (req.retry && !previous) return Promise.resolve({ ok: false, reason: "busy" });
        const id = randomId();
        const body = {
          id: id,
          action: req.retry ? previous.action : req.action,
          payload: req.retry ? previous.payload || {} : req.payload || {},
          source: { kind: "page" },
        };
        if (req.retry) body.retryOf = previous.id;
        if (req.trusted) body.userGesture = true;
        setAction({ id: id, action: body.action, payload: body.payload, status: "submitting" });
        return new Promise(function (resolve) {
          waiters.set(id, resolve);
          call("POST", "actions", body).then(function (response) {
            if (response.ok) {
              // The stream may have settled this action before the POST returned; that response is stale.
              if (!waiters.has(id)) return;
              setAction(actionEventFromDoc(response.body));
              settleIfClosed(id);
              return;
            }
            waiters.delete(id);
            if (response.status === 400 || response.status === 413) {
              setAction(null);
              resolve({
                ok: false,
                reason: response.status === 413 ? "payload_too_large" : "invalid_payload",
              });
              return;
            }
            readAction(id).then(function (doc) {
              if (doc.ok) {
                setAction(actionEventFromDoc(doc.body));
                resolve(resultFromDoc(doc.body) || { ok: false, reason: "failed", id: id });
              } else {
                setAction(null);
                resolve({ ok: false, reason: "session_unavailable" });
              }
            });
          });
        });
      },
      stateSave: function (app, controls) {
        call("POST", "db/docs/_state/page", { data: { app: app, controls: controls } });
      },
      subscribe: function () {},
      unsubscribe: function () {},
      requestFullscreen: function (open) {
        if (!open) {
          if (document.fullscreenElement) document.exitFullscreen();
          return Promise.resolve(false);
        }
        return document.documentElement.requestFullscreen().then(
          function () {
            return true;
          },
          function () {
            return false;
          },
        );
      },
    };
  }

  function actionEventFromDoc(doc) {
    const data = doc.data || {};
    let status = "queued";
    if (data.status === "pending")
      status = agentStatus.state === "working" ? "processing" : "queued";
    else if (data.status === "done") status = "completed";
    else if (data.status === "failed") status = data.error === "timeout" ? "timeout" : "error";
    return {
      id: doc.id,
      action: data.action,
      payload: data.payload,
      status: status,
      error: data.error,
      result: data.result,
    };
  }

  function resultFromDoc(doc) {
    const data = doc.data || {};
    if (data.status === "done") return { ok: true, id: doc.id, result: data.result };
    if (data.status === "failed") {
      return data.error === "timeout"
        ? { ok: false, reason: "timeout", id: doc.id }
        : { ok: false, reason: "failed", id: doc.id, error: data.error };
    }
    return null;
  }

  const transport = boot ? createPortTransport() : createPageTransport();

  // --------------------------------------------------------------- styles

  const STYLE = [
    "html{height:auto}",
    "html,body{background:transparent;color:var(--spur-text-primary);font-family:var(--spur-font,system-ui,sans-serif);font-size:12px;letter-spacing:.02em}",
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
    "spur-choice:focus-visible,.spur-btn:focus-visible,.spur-field input:focus-visible,.spur-field textarea:focus-visible,.spur-chat-form input:focus-visible{outline:2px solid var(--spur-accent);outline-offset:-2px}",
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
    // Spacing by margin, not gap: a page rule like `spur-chat{display:block}` must not
    // let the status line run into the scrolled log.
    "spur-chat{display:flex;flex-direction:column;border:1px solid var(--spur-border-default);padding:8px}",
    "spur-chat>*+*{margin-top:8px}",
    ".spur-chat-log{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;border-top:1px solid var(--spur-border-subtle);padding-top:8px}",
    ".spur-chat-log:empty{display:none}",
    ".spur-chat-msg{white-space:pre-wrap;line-height:1.5;padding:4px 8px;border-left:2px solid var(--spur-border-subtle)}",
    ".spur-chat-msg[data-role=assistant]{border-left-color:var(--spur-accent)}",
    ".spur-chat-msg[data-kind=action]{font-size:11px;color:var(--spur-text-secondary)}",
    ".spur-chat-tag{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--spur-text-tertiary);margin-right:8px}",
    ".spur-chat-status{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--spur-text-tertiary)}",
    ".spur-chat-status[data-tone=error]{color:var(--spur-status-error)}",
    ".spur-chat-form{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px}",
    ".spur-chat-form textarea{width:100%;min-width:0;resize:vertical;font:inherit;color:var(--spur-text-primary);background:var(--spur-input-bg);border:1px solid var(--spur-input-border);padding:6px 8px;border-radius:0}",
    ".spur-chat-form textarea:focus-visible{outline:2px solid var(--spur-accent);outline-offset:-2px}",
    ".spur-chat-form textarea[aria-invalid=true]{border-color:var(--spur-status-error)}",
    ".spur-chat-form textarea:disabled{opacity:.55}",
    ".spur-chat-voice{flex:1;min-width:0;width:0;height:36px;border:0;background:var(--spur-bg-surface)}",
  ].join("\n");

  function installStyles() {
    const style = document.createElement("style");
    style.setAttribute("data-spur-sdk", "");
    style.textContent = boot
      ? STYLE
      : STYLE.split("\n")
          .filter(function (line) {
            return !/^(html|body|\*)/.test(line);
          })
          .join("\n");
    const head = document.head || document.documentElement;
    head.insertBefore(style, head.firstChild);
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

  // Pre-delivery rejections never reach the agent; `failed`/`timeout` come from the doc.
  function isPreDelivery(result) {
    return !result.ok && result.reason !== "failed" && result.reason !== "timeout";
  }

  function invokeAction(name, payload, trusted, retry) {
    if (!transport.connected()) return Promise.resolve({ ok: false, reason: "not_connected" });
    if (!retry && isBusy()) return Promise.resolve({ ok: false, reason: "busy" });
    const before = action;
    return transport
      .invoke({ action: name, payload: payload || {}, trusted: trusted === true, retry: retry })
      .then(function (result) {
        if (result.ok) {
          clearRejection();
        } else if (isPreDelivery(result)) {
          if (action && action.status === "awaiting_confirm") {
            action = before;
            if (before) emit("action", before);
          }
          showRejection(result);
        } else {
          refreshControls();
        }
        return result;
      });
  }

  function retryAction(trusted) {
    if (!action || RETRYABLE.indexOf(action.status) < 0) {
      return Promise.resolve({ ok: false, reason: "busy" });
    }
    return invokeAction(action.action, undefined, trusted, true);
  }

  // ----------------------------------------------------------------- agent

  function sendMessage(text, trusted) {
    const message = String(text || "").trim();
    if (!message) return Promise.resolve({ ok: false, reason: "invalid_payload" });
    if (!transport.connected()) return Promise.resolve({ ok: false, reason: "not_connected" });
    return transport
      .agent("send", { message: message, userGesture: trusted === true })
      .then(function (response) {
        return response.ok
          ? { ok: true, sessionId: response.body.sessionId }
          : { ok: false, reason: "session_unavailable", error: response.body.error };
      });
  }

  // One poller per document, shared by every onMessage listener and <spur-chat>.
  const messagePoll = {
    timer: null,
    sessionId: null,
    from: undefined,
    seen: new Set(),
    messages: [],
  };

  function pollMessages() {
    const args = messagePoll.from === undefined ? {} : { from: messagePoll.from };
    return transport.agent("messages", args).then(function (response) {
      if (!response.ok) return;
      const body = response.body;
      if (body.status) setAgentStatus(body.status);
      // The cursor indexes one session's conversation: a new agent session starts over.
      if (body.sessionId !== messagePoll.sessionId) {
        messagePoll.sessionId = body.sessionId;
        if (messagePoll.from !== undefined) {
          messagePoll.from = undefined;
          return pollMessages();
        }
      }
      if (body.sessionId === null) return;
      (body.messages || []).forEach(function (message) {
        const key = body.sessionId + ":" + message.index;
        if (messagePoll.seen.has(key)) return;
        messagePoll.seen.add(key);
        messagePoll.messages.push(message);
        emit("message", message);
      });
      if (typeof body.nextFrom === "number") messagePoll.from = body.nextFrom;
    });
  }

  function startMessagePoll() {
    if (messagePoll.timer !== null) return;
    const tick = function () {
      pollMessages().finally(function () {
        messagePoll.timer = setTimeout(tick, AGENT_POLL_MS);
      });
    };
    messagePoll.timer = 0;
    readyPromise.then(tick);
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
    if (!transport.connected() || stateTimer !== null) return;
    stateTimer = setTimeout(function () {
      stateTimer = null;
      transport.stateSave(appState, collectControls());
    }, STATE_WINDOW_MS);
  }

  function noteControlChange(node) {
    if (node.getAttribute("id")) scheduleStateSend();
    if (node.hasAttribute("aria-invalid") && typeof node.setIssue === "function")
      node.setIssue(null);
  }

  // ------------------------------------------------------------------- db

  const snapshots = new Set();

  function dispatchChange(change) {
    snapshots.forEach(function (snapshot) {
      if (snapshot.collection === change.collection) snapshot.run();
    });
  }

  function refreshSnapshots() {
    snapshots.forEach(function (snapshot) {
      snapshot.run();
    });
  }

  function dbResult(response) {
    if (response.ok) return response.body;
    const error = new Error((response.body && response.body.error) || "Store request failed");
    error.status = response.status;
    throw error;
  }

  function makeQuery(collection, clauses) {
    function body() {
      const out = {};
      if (clauses.where.length) out.where = clauses.where;
      if (clauses.orderBy) out.orderBy = clauses.orderBy;
      if (clauses.limit !== undefined) out.limit = clauses.limit;
      if (clauses.startAfter !== undefined) out.startAfter = clauses.startAfter;
      return out;
    }
    const query = {
      where: function (field, op, value) {
        return makeQuery(
          collection,
          Object.assign({}, clauses, {
            where: clauses.where.concat([{ field: field, op: op, value: value }]),
          }),
        );
      },
      orderBy: function (field, direction) {
        return makeQuery(
          collection,
          Object.assign({}, clauses, { orderBy: { field: field, direction: direction || "asc" } }),
        );
      },
      limit: function (count) {
        return makeQuery(collection, Object.assign({}, clauses, { limit: count }));
      },
      startAfter: function (docId) {
        return makeQuery(collection, Object.assign({}, clauses, { startAfter: docId }));
      },
      get: function () {
        return readyPromise
          .then(function () {
            return transport.db("POST", "query/" + encodeSegment(collection), body());
          })
          .then(dbResult)
          .then(function (result) {
            return result.docs;
          });
      },
      onSnapshot: function (callback, onError) {
        let generation = 0;
        const snapshot = {
          collection: collection,
          run: function () {
            generation += 1;
            const mine = generation;
            query.get().then(
              function (docs) {
                if (mine === generation && snapshots.has(snapshot)) callback(docs);
              },
              function (error) {
                if (onError) onError(error);
              },
            );
          },
        };
        snapshots.add(snapshot);
        if (snapshots.size === 1)
          readyPromise.then(function () {
            transport.subscribe(context.dataStore);
          });
        snapshot.run();
        return function () {
          snapshots.delete(snapshot);
          if (snapshots.size === 0) transport.unsubscribe(context.dataStore);
        };
      },
    };
    return query;
  }

  function collectionRef(collection) {
    const ref = makeQuery(collection, { where: [] });
    ref.add = function (data) {
      return readyPromise
        .then(function () {
          return transport.db("POST", "docs/" + encodeSegment(collection), { data: data });
        })
        .then(dbResult);
    };
    ref.doc = function (docId) {
      const path = "docs/" + encodeSegment(collection) + "/" + encodeSegment(docId);
      function write(method, data, options) {
        const payload = { data: data };
        if (options && options.expectedRev !== undefined) payload.expectedRev = options.expectedRev;
        return readyPromise
          .then(function () {
            return transport.db(method, path, payload);
          })
          .then(dbResult);
      }
      return {
        id: docId,
        get: function () {
          return readyPromise
            .then(function () {
              return transport.db("GET", path);
            })
            .then(function (response) {
              return response.status === 404 ? null : dbResult(response);
            });
        },
        set: function (data, options) {
          return write("POST", data, options);
        },
        update: function (data, options) {
          return write("PATCH", data, options);
        },
        delete: function () {
          return readyPromise
            .then(function () {
              return transport.db("DELETE", path);
            })
            .then(dbResult);
        },
      };
    };
    return ref;
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
    db: {
      collection: function (name) {
        return collectionRef(name);
      },
    },
    state: {
      get: function () {
        return appState;
      },
      set: function (value) {
        if (byteLength(value) > STATE_MAX_BYTES) throw new RangeError("spur state over 64 KiB");
        appState = value;
        scheduleStateSend();
      },
    },
    agent: {
      invoke: function (name, payload) {
        return invokeAction(name, payload, false, false);
      },
      retry: function () {
        return retryAction(false);
      },
      send: function (text) {
        return sendMessage(text, false);
      },
      onMessage: function (handler) {
        startMessagePoll();
        return sdk.on("message", handler);
      },
      status: function () {
        return readyPromise
          .then(function () {
            return transport.agent("status");
          })
          .then(function (response) {
            if (response.ok) setAgentStatus(response.body);
            return agentStatus;
          });
      },
    },
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
    requestFullscreen: function () {
      if (!transport.connected()) return Promise.resolve(false);
      return transport.requestFullscreen(true);
    },
    exitFullscreen: function () {
      transport.requestFullscreen(false);
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

  // -------------------------------------------------------------- theme + boot

  function applyTheme(theme) {
    const root = document.documentElement;
    // Without it Chromium paints an opaque light canvas under a dark host.
    root.style.colorScheme = theme.mode || "light dark";
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

  installStyles();
  new MutationObserver(function () {
    queueMicrotask(applyControlState);
  }).observe(document.documentElement, { childList: true, subtree: true });
  transport.connect().then(function (ctx) {
    context = ctx;
    if (ctx.availability) availability = ctx.availability;
    if (ctx.action !== undefined) action = ctx.action;
    if (ctx.agentStatus) setAgentStatus(ctx.agentStatus);
    appState = ctx.state === undefined ? null : ctx.state;
    if (ctx.theme) applyTheme(ctx.theme);
    whenParsed(refreshControls);
    restoreControls(ctx.controls || []);
    readyResolve(ctx);
  });

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
                if (form) form.submit(keyEvent.isTrusted);
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
          button.addEventListener("click", (clickEvent) => {
            this.press(clickEvent.isTrusted);
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
      press(trusted) {
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
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- retain the invoking element identity for its spinner
        invokingEl = this;
        invokeAction(id, payload, trusted === true, false);
      }
    },
  );

  define(
    "spur-form",
    class extends HTMLElement {
      collect() {
        return gatherForm(this);
      }
      submit(trusted) {
        const id = this.getAttribute("action");
        if (!id || this.hasAttribute("disabled")) return;
        invokingEl = this.querySelector('spur-button[type="submit"]');
        invokeAction(id, this.collect(), trusted === true, false);
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
          if (clickEvent.target.closest && clickEvent.target.closest("[data-spur-retry]"))
            retryAction(clickEvent.isTrusted);
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
          if (status === "error") tone = "error";
          head.appendChild(el("span", "", label));
          if (RETRYABLE.indexOf(status) >= 0) {
            const again = el("button", "spur-btn", "Retry");
            again.type = "button";
            again.setAttribute("data-spur-retry", "");
            head.appendChild(again);
          }
          this.appendChild(head);
          if (status === "error" && action.error) {
            this.appendChild(el("div", "spur-status-note", String(action.error)));
          }
          if (status === "timeout") {
            this.appendChild(
              el("div", "spur-status-note", "The agent did not close the action in 15 min."),
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

  // Chat with the store's agent. Messages render through textContent only.
  define(
    "spur-chat",
    class extends HTMLElement {
      connectedCallback() {
        whenParsed(() => {
          if (!this.isConnected) return;
          if (this._ready) {
            this._attach();
            return;
          }
          this._ready = true;
          this._chatId = randomId();
          const status = el("div", "spur-chat-status", AGENT_LABELS[agentStatus.state] || "");
          const log = el("div", "spur-chat-log");
          log.setAttribute("role", "log");
          log.setAttribute("aria-live", "polite");
          const form = el("div", "spur-chat-form");
          const input = document.createElement("textarea");
          input.rows = 3;
          input.maxLength = 20000;
          input.placeholder = this.getAttribute("placeholder") || "Message the agent...";
          input.setAttribute("aria-label", "Message");
          const send = el("button", "spur-btn", "Send");
          send.type = "button";
          form.appendChild(input);
          form.appendChild(send);
          this.appendChild(status);
          this.appendChild(log);
          this.appendChild(form);
          this._input = input;
          this._form = form;
          this._status = status;
          const render = (message) => {
            const node = el("div", "spur-chat-msg");
            if (message.kind === "action") node.appendChild(el("span", "spur-chat-tag", "Action"));
            node.appendChild(document.createTextNode(message.text));
            node.setAttribute("data-role", message.role);
            if (message.kind) node.setAttribute("data-kind", message.kind);
            log.appendChild(node);
            log.scrollTop = log.scrollHeight;
          };
          this._renderMessage = render;
          this._renderStatus = function (next) {
            status.textContent = AGENT_LABELS[next.state] || next.state;
            status.removeAttribute("data-tone");
          };
          messagePoll.messages.forEach(render);
          this._attach();
          input.addEventListener("focus", () => {
            if (transport.kind === "port") transport.chatTarget(MSG.chatFocus, this._chatId);
          });
          input.addEventListener("input", function () {
            input.removeAttribute("aria-invalid");
          });
          send.addEventListener("click", (clickEvent) => {
            const text = input.value.trim();
            if (!text) return;
            if (text.length > 20000) {
              this._voiceError("Message exceeds 20,000 characters");
              return;
            }
            send.disabled = true;
            input.disabled = true;
            status.removeAttribute("data-tone");
            status.textContent = "Sending…";
            sendMessage(text, clickEvent.isTrusted).then(function (result) {
              send.disabled = false;
              input.disabled = false;
              input.focus();
              if (result.ok) {
                input.value = "";
                input.removeAttribute("aria-invalid");
                status.textContent = AGENT_LABELS[agentStatus.state] || agentStatus.state;
              } else {
                input.setAttribute("aria-invalid", "true");
                status.setAttribute("data-tone", "error");
                status.textContent = result.error || REJECTION_TEXT[result.reason] || "Not sent";
              }
            });
          });
        });
      }
      _attach() {
        if (this._offMessage) return;
        chats.set(this._chatId, this);
        this._offMessage = sdk.agent.onMessage(this._renderMessage);
        this._offAgent = sdk.on("agent", this._renderStatus);
        if (transport.kind === "port") {
          sdk.ready().then(() => {
            if (this.isConnected) transport.chatTarget(MSG.chatRegister, this._chatId);
          });
        } else if (!this.hasAttribute("data-floating-chat")) this.setVoiceActive(true);
      }
      _voiceError(message) {
        this._status.textContent = message;
        this._status.setAttribute("data-tone", "error");
      }
      insertTranscript(text) {
        if (!this.isConnected || typeof text !== "string" || this._input.disabled) return;
        const input = this._input;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const next = input.value.slice(0, start) + text + input.value.slice(end);
        if (next.length > 20000) {
          this._voiceError("Dictation exceeds 20,000 characters");
          return;
        }
        input.value = next;
        input.setSelectionRange(start + text.length, start + text.length);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setVoiceActive(active) {
        if (transport.kind !== "page" || !this._form) return;
        if (!active) {
          if (this._voiceFrame) this._voiceFrame.remove();
          if (this._voiceListener) window.removeEventListener("message", this._voiceListener);
          this._voiceFrame = null;
          this._voiceListener = null;
          return;
        }
        if (this._voiceFrame) return;
        const frame = document.createElement("iframe");
        const nonce = randomId();
        const page = pageMatch[1];
        const chat = this._chatId;
        const origin = window.location.origin;
        frame.className = "spur-chat-voice";
        frame.title = "Voice input";
        frame.allow = "microphone";
        frame.src = "/page-voice?" + new URLSearchParams({ page: page, chat: chat, nonce: nonce });
        this._voiceFrame = frame;
        this._voiceListener = (event) => {
          const data = event.data;
          if (
            this._voiceFrame !== frame ||
            !this.isConnected ||
            event.origin !== origin ||
            event.source !== frame.contentWindow ||
            !data ||
            data.page !== page ||
            data.chat !== chat ||
            data.nonce !== nonce
          )
            return;
          if (data.type === "spur:voice-ready")
            frame.contentWindow.postMessage(
              { type: "spur:voice-connect", page: page, chat: chat, nonce: nonce },
              origin,
            );
          if (
            data.type === "spur:voice-transcript" &&
            typeof data.text === "string" &&
            data.text.length <= 20000
          )
            this.insertTranscript(data.text);
          if (
            data.type === "spur:voice-size" &&
            typeof data.height === "number" &&
            Number.isFinite(data.height)
          )
            frame.style.height = Math.min(120, Math.max(36, data.height)) + "px";
        };
        window.addEventListener("message", this._voiceListener);
        this._form.insertBefore(frame, this._form.lastChild);
      }
      disconnectedCallback() {
        this.setVoiceActive(false);
        chats.delete(this._chatId);
        if (this._offMessage) this._offMessage();
        if (this._offAgent) this._offAgent();
        this._offMessage = null;
        this._offAgent = null;
        if (transport.kind === "port" && this._chatId)
          transport.chatTarget(MSG.chatUnregister, this._chatId);
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
    invokeAction(
      node.getAttribute("data-spur-action"),
      parseJsonObject(node.getAttribute("data-spur-payload")),
      clickEvent.isTrusted,
      false,
    );
  });

  function installPageWidget() {
    if (boot || !pageRoot || document.querySelector("[data-spur-page-widget]")) return;
    const host = document.createElement("div");
    host.setAttribute("data-spur-page-widget", "");
    host.style.cssText =
      "all:initial!important;font:12px ui-monospace,monospace!important;color:var(--spur-text-primary)!important;position:fixed!important;inset:auto var(--spur-widget-inset) var(--spur-widget-inset) auto!important;z-index:2147483646!important;max-width:calc(100vw - 32px)!important";
    const root = host.attachShadow({ mode: "open" });
    const styles = document.createElement("style");
    styles.textContent =
      STYLE +
      "\n:host{--spur-widget-inset:24px}[hidden]{display:none!important}.panel{width:360px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 100px);overflow:auto;background:var(--spur-bg-surface);border:1px solid var(--spur-border-default);margin-bottom:8px}.head{display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid var(--spur-border-subtle);font-weight:700;text-transform:uppercase}.panel spur-chat{border:0}.toggle{width:48px;height:48px;margin-left:auto;display:flex;align-items:center;justify-content:center;background:var(--spur-bg-surface);padding:0}.toggle svg{width:22px;height:22px}.panel .spur-chat-msg{overflow-wrap:anywhere}.panel .spur-chat-log{max-height:min(320px,40dvh)}@media(max-width:639px){.toggle{width:44px;height:44px}:host{--spur-widget-inset:16px}}";
    root.appendChild(styles);
    const panel = el("section", "panel");
    panel.hidden = true;
    panel.setAttribute("aria-label", "Page agent chat");
    const header = el("div", "head");
    header.appendChild(el("span", "", "Page agent"));
    const close = el("button", "spur-btn", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close agent chat");
    header.appendChild(close);
    panel.appendChild(header);
    const chat = document.createElement("spur-chat");
    chat.setAttribute("data-floating-chat", "");
    panel.appendChild(chat);
    root.appendChild(panel);
    const toggle = el("button", "spur-btn toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Open agent chat");
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3v3M9 3h6M4 9h16v12H4zM1 12v6M23 12v6M8 17h8M8 12h1M15 12h1"/></svg>';
    root.appendChild(toggle);
    let open = false;
    function setOpen(next) {
      open = next;
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close agent chat" : "Open agent chat");
      chat.setVoiceActive(open);
      if (open && chat._input) chat._input.focus();
      if (!open) toggle.focus();
    }
    toggle.addEventListener("click", function () {
      setOpen(!open);
    });
    close.addEventListener("click", function () {
      setOpen(false);
    });
    root.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
      }
    });
    window.addEventListener("pagehide", function () {
      chat.setVoiceActive(false);
    });
    window.addEventListener("pageshow", function (event) {
      if (event.persisted && open) chat.setVoiceActive(true);
    });
    document.body.appendChild(host);
    const url = new URL(window.location.href);
    if (url.searchParams.get("chat") === "open") {
      url.searchParams.delete("chat");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      setOpen(true);
    }
  }
  whenParsed(installPageWidget);
})();
