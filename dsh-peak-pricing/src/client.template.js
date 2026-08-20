/* =========================================================================
 * dsh-peak-pricing · client bundle 源模板
 *
 * build-client.mjs 会把 src/schedule.js（剥离 export 前缀）与本文件拼在一起，
 * 再包进 window.__ModuleLoader__.load({ id, factory }) 外壳生成 lib/client.js。
 *
 * 运行时约定：
 *   - factory(require) 返回 module.exports；
 *   - 导出 apply(ctx) 与 inject；
 *   - 依赖 react（boot 图中的平台种子模块）。
 *
 * 前端职责（对应方案 1/3）：
 *   - 从 GET /__dsh-peak-pricing/config 拉取高峰期定义；
 *   - 通过 ctx.modelDirectories 读取当前会话选中的 provider/model；
 *   - 用共享 schedule 逻辑判断高峰/低谷，常显状态胶囊并在进出高峰时通知；
 *   - 拦截当前会话 InputShell.submit：高峰提交时调用 host 的
 *     /__dsh-peak-pricing/submit-confirm，由 ctx.userQuestions 在对话窗口
 *     中提问；选择“暂不开始”则不调用原 submit，草稿自然留在输入框。
 * ========================================================================= */

const CONFIG_URL = "/__dsh-peak-pricing/config";
const SUBMIT_CONFIRM_URL = "/__dsh-peak-pricing/submit-confirm";
const TICK_MS = 5000;
const CONFIG_TICKS = 6; // 每 30 秒重拉一次配置
const NOTICE_LIFETIME_MS = 8000;

const react = require("react");
const {
  createElement,
  useEffect,
  useSyncExternalStore,
} = react;

const h = createElement;
const EMPTY_CONFIG = normalizeConfig({ rules: [] });

/* ---- 轻量 snapshot store（不依赖 client-runtime 的值导入） ---- */
function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(patch) {
      state = { ...state, ...patch };
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error("[dsh-peak-pricing] store subscriber failed:", error);
        }
      }
    },
  };
}

function sameModel(left, right) {
  if (left === null || right === null) return left === right;
  return left.provider === right.provider && left.model === right.model;
}

function modelLabel(model) {
  if (model === null) return "";
  if (model.provider === "") return model.model;
  return `${model.provider}/${model.model}`;
}

/** 安全地渲染命中时段的文字描述；period 缺失或非法时给出兜底文案，避免在文案里拼出 undefined。 */
function peakPeriodText(peak) {
  const period = peak?.period;
  if (period === undefined || period === null) return "时段未知";
  let range = "时段未知";
  try {
    range = periodLabel(period);
  } catch {
    range = "时段未知";
  }
  return `${range}（${peak.timeZone ?? ""}，${daysLabel(period.days)}）`;
}

/* ---- 前端控制器：配置、模型订阅、高峰状态、提交拦截、对话窗口确认 ---- */
function createController(ctx) {
  const store = createStore({
    config: EMPTY_CONFIG,
    configState: "loading",
    configError: null,
    configPresent: false,
    sessionId: null,
    model: null,
    peak: null,
    initialized: false,
    notice: null,
  });

  let disposed = false;
  let boundSessionId = null;
  let modelDirectory = null;
  let modelUnsubscribe = null;
  let lastModelKey = "";
  let lastWasPeak = false;
  let tick = 0;
  let tickTimer = null;
  let submitPrompt = null;
  const patchedShells = new Map();

  const sessions = ctx.sessions;
  const modelDirectories = ctx.get("modelDirectories") ?? null;
  const conversation = ctx.get("conversation") ?? null;

  function currentPeakFor(model, now) {
    if (model === null || disposed) return null;
    const config = store.getSnapshot().config;
    if (config === null) return null;
    try {
      return peakStateAt(config.rules, model.provider, model.model, now);
    } catch (error) {
      console.warn("[dsh-peak-pricing] peak evaluation failed:", error);
      return null;
    }
  }

  function noticeFor(peak, model) {
    if (peak === null || model === null) return null;
    const label = modelLabel(model);
    if (peak.peak) {
      return {
        tone: "peak",
        text: `${label} 已进入高峰时段（${peakPeriodText(peak)}）`,
      };
    }
    return {
      tone: "off",
      text: `${label} 已离开高峰时段`,
    };
  }

  function recompute(now = Date.now()) {
    if (disposed) return;
    const snapshot = store.getSnapshot();
    const peak = currentPeakFor(snapshot.model, now);
    const key = snapshot.model === null
      ? `${snapshot.sessionId ?? ""}|`
      : `${snapshot.sessionId ?? ""}|${snapshot.model.provider}|${snapshot.model.model}`;
    let notice = snapshot.notice;

    if (!snapshot.initialized) {
      lastModelKey = key;
      lastWasPeak = peak !== null && peak.peak;
      store.update({ peak, initialized: true });
      return;
    }

    if (key !== lastModelKey) {
      // 会话或模型切换：只更新状态，不作为“进入/离开高峰”通知。
      lastModelKey = key;
      lastWasPeak = peak !== null && peak.peak;
    } else if (snapshot.model !== null && peak !== null && peak.peak !== lastWasPeak) {
      const candidate = noticeFor(peak, snapshot.model);
      if (candidate !== null) {
        notice = {
          seq: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ...candidate,
        };
      }
      lastWasPeak = peak.peak;
    } else if (snapshot.model !== null && peak !== null) {
      lastWasPeak = peak.peak;
    }

    store.update({ peak, notice });
  }

  function adoptDirectorySnapshot(directory) {
    if (disposed || directory === null) return;
    let next = null;
    try {
      const current = directory.store.getSnapshot().current;
      if (current !== null && current !== undefined) {
        next = {
          provider: String(current.provider ?? ""),
          model: String(current.model ?? ""),
        };
      }
    } catch (error) {
      console.warn("[dsh-peak-pricing] model directory read failed:", error);
    }
    const snapshot = store.getSnapshot();
    if (!sameModel(snapshot.model, next)) {
      store.update({ model: next });
    }
    recompute();
  }

  function unbindModel() {
    if (modelUnsubscribe !== null) {
      try {
        modelUnsubscribe();
      } catch {
        // 订阅已随 session scope 释放。
      }
      modelUnsubscribe = null;
    }
    modelDirectory = null;
  }

  function bindSession(sessionId) {
    if (disposed || sessionId === boundSessionId) return;
    unbindModel();
    boundSessionId = sessionId;
    store.update({
      sessionId,
      model: null,
      peak: null,
    });
    if (sessionId !== null && sessionId !== undefined && modelDirectories !== null) {
      try {
        modelDirectory = modelDirectories.directoryFor(sessionId);
        modelUnsubscribe = modelDirectory.store.subscribe(() => {
          adoptDirectorySnapshot(modelDirectory);
        });
        adoptDirectorySnapshot(modelDirectory);
        try {
          void modelDirectory.load().catch(() => {});
        } catch {
          // 目录不可用（如 addressed subagent）时保持“未选择模型”。
        }
      } catch (error) {
        console.warn("[dsh-peak-pricing] model directory bind failed:", error);
        modelDirectory = null;
      }
    }
    recompute();
    ensureSubmitPatch(sessionId);
  }

  function ensureSubmitPatch(sessionId) {
    if (disposed || conversation === null || sessionId === null || sessionId === undefined) return;
    let scope;
    try {
      scope = sessions.scope(sessionId);
    } catch {
      return;
    }
    if (scope === undefined) return;
    let shell;
    try {
      shell = conversation.input.for(scope);
    } catch (error) {
      console.warn("[dsh-peak-pricing] input shell resolve failed:", error);
      return;
    }
    if (patchedShells.has(shell)) return;

    const originalSubmit = shell.submit;
    if (typeof originalSubmit !== "function") return;
    const hadOwn = Object.hasOwn(shell, "submit");
    const wrappedSubmit = function (mode) {
      const resolvedMode = mode === undefined ? "queue" : mode;
      requestSubmit(sessionId, resolvedMode, () => {
        originalSubmit.call(shell, resolvedMode);
      });
    };
    shell.submit = wrappedSubmit;
    patchedShells.set(shell, { originalSubmit, hadOwn });
  }

  async function requestSubmit(sessionId, mode, proceed) {
    if (disposed) return;
    let proceedCalled = false;
    const callProceed = () => {
      if (proceedCalled) return;
      proceedCalled = true;
      try {
        proceed();
      } catch (error) {
        console.error("[dsh-peak-pricing] resume submit failed:", error);
      }
    };

    recompute();
    const snapshot = store.getSnapshot();
    if (snapshot.sessionId !== sessionId) {
      callProceed();
      return;
    }
    const peak = snapshot.peak;
    const model = snapshot.model;
    if (snapshot.configState !== "ready" || model === null || peak === null || !peak.peak) {
      callProceed();
      return;
    }
    if (submitPrompt !== null && submitPrompt.sessionId === sessionId) {
      return; // 对话窗口中的确认问题已打开，吞掉重复提交手势。
    }

    const attempt = { sessionId, mode };
    submitPrompt = attempt;
    try {
      const response = await fetch(SUBMIT_CONFIRM_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId,
          provider: model.provider,
          model: model.model,
        }),
        cache: "no-store",
      });
      const wire = await response.json().catch(() => null);
      const current = store.getSnapshot();
      if (disposed || current.sessionId !== sessionId) return;
      if (wire?.ok !== true) {
        // host 明确失败或无法提问：不把输入提交挂起。
        callProceed();
        return;
      }
      if (wire.action === "defer") return; // 草稿保留在输入框。
      callProceed();
    } catch (error) {
      console.error("[dsh-peak-pricing] submit confirmation failed, continuing:", error);
      const current = store.getSnapshot();
      if (!disposed && current.sessionId === sessionId) callProceed();
    } finally {
      if (submitPrompt === attempt) submitPrompt = null;
    }
  }

  function clearNotice(seq) {
    const snapshot = store.getSnapshot();
    if (snapshot.notice !== null && snapshot.notice.seq === seq) {
      store.update({ notice: null });
    }
  }

  async function refreshConfig() {
    if (disposed) return;
    try {
      const response = await fetch(CONFIG_URL, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const wire = await response.json();
      if (wire && wire.ok === false) throw new Error(wire.error || "config endpoint rejected");
      const config = normalizeConfig(wire);
      store.update({
        config,
        configState: "ready",
        configError: null,
        configPresent: wire?.present === true,
      });
    } catch (error) {
      store.update({
        configState: "error",
        configError: error instanceof Error ? error.message : String(error),
      });
    }
    recompute();
  }

  function onSessionsChanged() {
    if (disposed) return;
    const current = sessions.list.getSnapshot().current ?? null;
    if (current !== boundSessionId) {
      bindSession(current);
    } else {
      ensureSubmitPatch(current);
    }
  }

  const disposeSessions = sessions.list.subscribe(onSessionsChanged);

  function start() {
    if (disposed) return;
    onSessionsChanged();
    void refreshConfig();
    tickTimer = setInterval(() => {
      recompute();
      tick += 1;
      if (tick % CONFIG_TICKS === 0) void refreshConfig();
    }, TICK_MS);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") {
      recompute();
      void refreshConfig();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    disposeSessions();
    unbindModel();
    if (tickTimer !== null) clearInterval(tickTimer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    for (const [shell, record] of patchedShells) {
      try {
        if (record.hadOwn) shell.submit = record.originalSubmit;
        else delete shell.submit;
      } catch {
        // shell 已随 session 释放。
      }
    }
    patchedShells.clear();
  }

  const api = {
    store,
    clearNotice,
  };

  return {
    api,
    store,
    start,
    dispose,
    recompute,
  };
}

/* ---- 高峰/低谷状态胶囊与进入/离开通知 ---- */
function statusCopy(snapshot) {
  if (snapshot.configState === "error") {
    return { text: "高峰计价 · 配置错误", className: "dshpp-pill dshpp-error" };
  }
  if (snapshot.model === null) {
    return { text: "高峰计价 · 未选择模型", className: "dshpp-pill dshpp-neutral" };
  }
  const label = modelLabel(snapshot.model);
  if (snapshot.peak !== null && snapshot.peak.peak) {
    return { text: `高峰 · ${label}`, className: "dshpp-pill dshpp-peak" };
  }
  return { text: `低谷 · ${label}`, className: "dshpp-pill dshpp-off" };
}

function statusTitle(snapshot) {
  if (snapshot.configState === "error") {
    return `高峰计价配置读取失败：${snapshot.configError ?? "unknown"}`;
  }
  if (snapshot.model === null) {
    return "尚未读取到当前会话的模型选择";
  }
  if (snapshot.peak !== null && snapshot.peak.peak) {
    return `高峰期：${peakPeriodText(snapshot.peak)}`;
  }
  if (snapshot.peak !== null) {
    return "当前时段为低谷";
  }
  return "高峰期定义尚未就绪";
}

function PeakPricingOverlay(props) {
  const { store, api } = props;
  const snapshot = useSyncExternalStore(
    fn => store.subscribe(fn),
    () => store.getSnapshot(),
  );

  useEffect(() => {
    if (snapshot.notice === null) return;
    const seq = snapshot.notice.seq;
    const timer = setTimeout(() => api.clearNotice(seq), NOTICE_LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [snapshot.notice?.seq]);

  const status = statusCopy(snapshot);

  return h(
    "div",
    { className: "dshpp-root" },
    snapshot.notice === null
      ? null
      : h(
        "div",
        {
          className: `dshpp-notice dshpp-notice-${snapshot.notice.tone}`,
          role: "status",
        },
        snapshot.notice.text,
      ),
    h(
      "div",
      {
        className: status.className,
        title: statusTitle(snapshot),
        role: "status",
      },
      status.text,
    ),
  );
}

/* ---- CSS ---- */
const CSS = `
.dshpp-root{position:fixed;right:14px;bottom:12px;z-index:10000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-family:var(--dsw-font-family,inherit);}
.dshpp-pill{pointer-events:auto;padding:5px 10px;border-radius:999px;font-size:12px;line-height:1.3;white-space:nowrap;border:1px solid var(--dsw-alias-border-l1,#30363d);background:var(--dsw-alias-interactive-bg-default,rgba(22,27,34,.92));color:var(--dsw-alias-text-primary,#e6edf3);box-shadow:0 4px 14px rgba(0,0,0,.25);}
.dshpp-peak{background:rgba(180,90,30,.92);border-color:rgba(255,150,70,.55);color:#fff7ed;}
.dshpp-off{background:rgba(22,110,70,.92);border-color:rgba(90,220,140,.5);color:#ecfff5;}
.dshpp-neutral{opacity:.82;}
.dshpp-error{background:rgba(150,40,40,.92);border-color:rgba(255,110,110,.55);color:#fff2f2;}
.dshpp-notice{pointer-events:auto;max-width:340px;padding:8px 11px;border-radius:10px;font-size:12px;line-height:1.45;border:1px solid rgba(255,255,255,.14);background:rgba(22,27,34,.95);color:var(--dsw-alias-text-primary,#e6edf3);box-shadow:0 8px 28px rgba(0,0,0,.35);}
.dshpp-notice-peak{border-color:rgba(255,160,80,.55);}
.dshpp-notice-off{border-color:rgba(90,220,140,.5);}
`;
function injectCss() {
  if (typeof document === "undefined") return;
  const tagId = "dsh-peak-pricing/style.css";
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-peak-pricing";
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/* ---- 插件入口 ---- */
const inject = ["slots", "sessions", "modelDirectories", "conversation"];

function apply(ctx) {
  injectCss();
  const controller = createController(ctx);
  controller.start();

  const disposeSlot = ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "dsh-peak-pricing",
        order: 100,
        inject: () => ({
          store: controller.store,
          api: controller.api,
        }),
      },
      PeakPricingOverlay,
    ),
  );

  // InputBar 可能在插件 apply 之后才创建 shell；稍后补一次补丁。
  const patchTimer = setTimeout(() => {
    const sessionId = ctx.sessions.list.getSnapshot().current ?? null;
    if (sessionId !== null) {
      const snapshot = controller.store.getSnapshot();
      if (snapshot.sessionId === sessionId) controller.recompute();
    }
  }, 0);

  return () => {
    clearTimeout(patchTimer);
    disposeSlot();
    controller.dispose();
  };
}

module.exports.apply = apply;
module.exports.inject = inject;
