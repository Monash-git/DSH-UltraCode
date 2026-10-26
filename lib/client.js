window.__ModuleLoader__.load({
  id: "dsh-ultracode",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// locale/en.json
var en_default = {
  pause: "Pause",
  pausing: "Pausing\u2026",
  resume: "Resume",
  paused: "Paused",
  running: "Running",
  waitingJob: "Waiting for background job",
  pausingProgress: "Pausing\u2026 ({acknowledged}/{total} acknowledged)",
  pausedForced: "Paused \u2014 {forced} stopped after timeout",
  restartWarning: "Restart required: {warning}"
};

// locale/zh.json
var zh_default = {
  pause: "\u6682\u505C",
  pausing: "\u6B63\u5728\u6682\u505C\u2026",
  resume: "\u7EE7\u7EED",
  paused: "\u5DF2\u6682\u505C",
  running: "\u8FD0\u884C\u4E2D",
  waitingJob: "\u6B63\u5728\u7B49\u5F85\u540E\u53F0\u4EFB\u52A1",
  pausingProgress: "\u6B63\u5728\u6682\u505C\u2026\uFF08{acknowledged}/{total} \u5DF2\u786E\u8BA4\uFF09",
  pausedForced: "\u5DF2\u6682\u505C \u2014 {forced} \u4E2A\u5DF2\u8D85\u65F6\u5F3A\u5236\u505C\u6B62",
  restartWarning: "\u9700\u8981\u91CD\u542F\uFF1A{warning}"
};

// src/client/adapter.ts
var NS = "ultracode";
async function executeHostCommand(commands, sessionId, line) {
  const result = await commands.execute(sessionId, line, []);
  if (!result.ok) throw new Error(result.error?.message ?? "command failed");
  if (result.value?.result.kind === "error") {
    throw new Error(result.value.result.text ?? "command failed");
  }
}
function applyClient(ctx, component) {
  ctx.effect(() => ctx.locale.register(NS, { zh: zh_default, en: en_default }));
  ctx.slots.inject("conversation.input.primary", () => ctx.slots.register({
    name: "conversation.input.primary",
    locale: NS,
    inject: (sessionId) => ({
      executeCommand: (line) => executeHostCommand(ctx.remote.commands, sessionId, line)
    })
  }, component));
}

// src/client/view.ts
var DEFAULT_VIEW = Object.freeze({
  kind: "default",
  disabled: false,
  waitingOnJob: false,
  label: void 0
});
var ACTIVE_RUN_PHASES = /* @__PURE__ */ new Set(["armed", "running", "waiting_job"]);
function primaryView(state) {
  if (state.subagent || state.locked) return DEFAULT_VIEW;
  if (!state.empty || state.machineBusy || state.uploadsPending) return DEFAULT_VIEW;
  const progress = state.pause;
  if (state.paused) {
    if (progress?.phase === "pausing") {
      return { kind: "pause", disabled: true, waitingOnJob: false, label: "pausing", progress };
    }
    return {
      kind: "play",
      disabled: state.pending || progress?.phase === "resuming",
      waitingOnJob: false,
      label: "resume",
      ...progress === void 0 ? {} : { progress }
    };
  }
  const activePhase = state.phase !== void 0 && ACTIVE_RUN_PHASES.has(state.phase);
  if (!state.running && !activePhase) return DEFAULT_VIEW;
  const pausing = state.pending || progress?.phase === "pausing";
  return {
    kind: "pause",
    // A running session without a live Stop cannot service a pause either.
    // Waiting-on-job Pause does not depend on the default Stop.
    disabled: pausing || state.running && !state.stopLive,
    waitingOnJob: state.phase === "waiting_job",
    label: pausing ? "pausing" : "pause",
    ...progress === void 0 ? {} : { progress }
  };
}
var FALLBACK_LABEL = {
  pause: en_default.pause,
  pausing: en_default.pausing,
  resume: en_default.resume
};
function primaryText(view, t) {
  if (view.label === void 0) return {};
  const lookup = (key) => t?.(key) ?? en_default[key];
  let label = t?.(view.label) ?? FALLBACK_LABEL[view.label];
  if (view.label === "pausing" && view.progress !== void 0 && (view.progress.total ?? 0) > 0) {
    label = format(lookup("pausingProgress"), {
      acknowledged: view.progress.acknowledged ?? 0,
      total: view.progress.total ?? 0
    });
  }
  if (view.waitingOnJob) {
    const waiting = lookup("waitingJob");
    const title = `${label} \u2014 ${waiting}`;
    return { label: title, title, status: waiting };
  }
  if (view.kind === "play") {
    const parts = [];
    if ((view.progress?.forced ?? 0) > 0) {
      parts.push(format(lookup("pausedForced"), { forced: view.progress?.forced ?? 0 }));
    }
    if (view.progress?.warning !== void 0 && view.progress.warning !== "") {
      parts.push(format(lookup("restartWarning"), { warning: view.progress.warning }));
    }
    if (parts.length > 0) {
      const status = parts.join(" ");
      const title = `${label} \u2014 ${status}`;
      return { label: title, title, status };
    }
  }
  return { label, title: label };
}
function format(template, values) {
  return template.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? ""));
}
function primaryCommand(kind) {
  if (kind === "pause") return "/pause";
  if (kind === "play") return "/resume";
  return void 0;
}
function primaryButtonProps(view, text, handlers, pending) {
  return {
    type: "button",
    "aria-label": text.label ?? "",
    ...pending ? { "aria-busy": true } : {},
    title: text.title ?? "",
    disabled: view.disabled,
    onMouseDown: handlers.keepFocus,
    onClick: handlers.activate
  };
}

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function noProjection(_key, _selector) {
  return void 0;
}
function PauseIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "3.5", y: "3", width: "3.5", height: "10", rx: "1", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "9", y: "3", width: "3.5", height: "10", rx: "1", fill: "currentColor" })
  ] });
}
function PlayIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M4.5 3.3c0-.8.9-1.3 1.6-.9l7 4.7c.6.4.6 1.4 0 1.8l-7 4.7c-.7.4-1.6-.1-1.6-.9V3.3Z", fill: "currentColor" }) });
}
function primaryButtonStyle(disabled) {
  return {
    display: "grid",
    placeItems: "center",
    flex: "none",
    width: 34,
    height: 34,
    border: "none",
    borderRadius: 999,
    background: "var(--dsw-alias-button-info-fill)",
    color: "#fff",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
    transform: "translateY(-2px)",
    transition: "background-color 100ms ease"
  };
}
function PrimaryAction(props) {
  const {
    defaultAction = null,
    empty = false,
    running = false,
    subagent = false,
    locked = false,
    machineBusy = false,
    uploadsPending = false,
    stopLive = false,
    keepFocus = () => {
    },
    useProjection = noProjection,
    t,
    executeCommand = async () => {
    }
  } = props;
  const projection = useProjection("ultracode", (value) => value);
  const [pending, setPending] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const status = projection?.pauseStatus;
  const view = primaryView({
    empty,
    running,
    subagent,
    locked,
    machineBusy,
    uploadsPending,
    stopLive,
    paused: projection?.paused === true,
    phase: projection?.run?.phase,
    pending,
    pause: status === void 0 || status === null ? void 0 : {
      phase: status.phase,
      acknowledged: status.acknowledged,
      total: status.total,
      forced: status.forced,
      warning: status.warning
    }
  });
  if (view.kind === "default") return defaultAction;
  const text = primaryText(view, t);
  const activate = () => {
    if (view.disabled) return;
    const command = primaryCommand(view.kind);
    if (command === void 0) return;
    setPending(true);
    setError(void 0);
    void executeCommand(command).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      setPending(false);
    });
  };
  const button = primaryButtonProps(view, text, { keepFocus, activate }, pending);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { ...button, style: primaryButtonStyle(view.disabled), children: view.kind === "play" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlayIcon, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PauseIcon, {}) }),
    text.status === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "status", style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" }, children: text.status }),
    error === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "status", style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)" }, children: error })
  ] });
}
function apply(ctx) {
  applyClient(ctx, PrimaryAction);
}
var inject = ["slots", "remote", "remote.commands", "locale"];

    return module.exports;
  }
});
