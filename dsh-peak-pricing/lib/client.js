window.__ModuleLoader__.load({
	id: "dsh-peak-pricing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
/* Shared schedule logic generated from src/schedule.js. */
/**
 * dsh-peak-pricing 共享的纯高峰时段计算逻辑。
 *
 * host 半区直接以 ESM 导入本文件；build-client.mjs 会把同一份源码
 * 剥离 `export ` 前缀后嵌入 lib/client.js（浏览器 bundle），两端共用逻辑。
 *
 * 规则语义：
 *   - provider 精确匹配（同时兼容 * ? 通配）；
 *   - model 支持 * ? 通配；既匹配裸模型名，也匹配 "provider/model" 全名；
 *   - timezone 缺省为本机时区；
 *   - start < end  当天时段（end 不含）；
 *   - start > end  跨午夜（end 位于次日，end 不含）；
 *   - start == end 全天；
 *   - days 缺省每天；显式传空数组表示不生效。
 */

const DAY_CODES = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])

const DAY_SET = new Set(DAY_CODES)
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 把通配符模式编译为正则（* → .*，? → .）。 */
function wildcardMatch(pattern, value) {
  const source = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^(?:${source})$`).test(String(value))
}

/** 解析 "HH:mm" 为分钟数；非法输入返回 null。 */
function parseHm(value) {
  if (typeof value !== 'string') return null
  const match = TIME_RE.exec(value)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 校验 IANA 时区名。 */
function assertValidTimeZone(timeZone, label) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone }).format(0)
  } catch {
    throw new TypeError(`${label} is not a valid IANA time zone: ${timeZone}`)
  }
}

/** 本机 IANA 时区名。 */
function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 使用目标时区取出年月日时分秒与星期。 */
function dateParts(date, timeZone) {
  const value = date instanceof Date ? date : new Date(date)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(value)
  const map = {}
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  let hour = Number(map.hour)
  if (hour === 24) hour = 0 // 部分 Intl 实现对午夜输出 24
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short',
  }).format(value).toLowerCase().slice(0, 3)
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday,
  }
}

/** 目标时区下的 YYYY-MM-DD 日期键。 */
function dateKey(parts) {
  const mm = String(parts.month).padStart(2, '0')
  const dd = String(parts.day).padStart(2, '0')
  return `${parts.year}-${mm}-${dd}`
}

/** 目标时区下偏移若干天后的日期键。 */
function shiftedDateKey(parts, timeZone, deltaDays) {
  const noon = Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays, 12)
  return dateKey(dateParts(new Date(noon), timeZone))
}

/** days 是否覆盖某星期；缺省表示每天，空数组表示不生效。 */
function dayMatches(days, weekday) {
  if (days === undefined || days === null) return true
  return days.includes(weekday)
}

/**
 * 计算一个 period 在当前时刻的状态。
 * @param {object} period - { days?, start, end }
 * @param {Date|number} date - 判定时刻。
 * @param {string} timeZone - 规则时区。
 * @returns {object} { active, nominalDay, endsAt }
 */
function periodStatusAt(period, date, timeZone) {
  const startMin = parseHm(period.start)
  const endMin = parseHm(period.end)
  if (startMin === null || endMin === null) {
    throw new TypeError(`invalid period time: ${JSON.stringify(period)}`)
  }
  const parts = dateParts(date, timeZone)
  const nowMin = parts.hour * 60 + parts.minute
  const today = dateKey(parts)
  const weekday = parts.weekday
  const days = period.days
  const endHour = Math.floor(endMin / 60)
  const endMinute = endMin % 60

  if (startMin === endMin) {
    if (!dayMatches(days, weekday)) {
      return { active: false, nominalDay: null, endsAt: null }
    }
    return {
      active: true,
      nominalDay: today,
      endsAt: Date.UTC(parts.year, parts.month - 1, parts.day + 1),
    }
  }

  if (startMin < endMin) {
    const active = dayMatches(days, weekday) && nowMin >= startMin && nowMin < endMin
    return {
      active,
      nominalDay: active ? today : null,
      endsAt: active
        ? Date.UTC(parts.year, parts.month - 1, parts.day, endHour, endMinute)
        : null,
    }
  }

  // 跨午夜：period 的名义日期是 start 所在日。
  const previous = shiftedDateKey(parts, timeZone, -1)
  const previousWeekday = dateParts(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1, 12)), timeZone,
  ).weekday
  const afterStart = nowMin >= startMin
  const beforeEnd = nowMin < endMin
  const activeFromToday = afterStart && dayMatches(days, weekday)
  const activeFromYesterday = beforeEnd && dayMatches(days, previousWeekday)

  if (activeFromToday) {
    return {
      active: true,
      nominalDay: today,
      endsAt: Date.UTC(parts.year, parts.month - 1, parts.day + 1, endHour, endMinute),
    }
  }
  if (activeFromYesterday) {
    return {
      active: true,
      nominalDay: previous,
      endsAt: Date.UTC(parts.year, parts.month - 1, parts.day, endHour, endMinute),
    }
  }
  return { active: false, nominalDay: null, endsAt: null }
}

/**
 * 判断一个规则是否匹配供应商和模型。
 * @param {object} rule - { provider, model }
 * @param {string} provider - 当前供应商。
 * @param {string} model - 当前模型名。
 * @returns {boolean}
 */
function matchesRule(rule, provider, model) {
  const providerPattern = typeof rule.provider === 'string' && rule.provider !== ''
    ? rule.provider
    : '*'
  if (!wildcardMatch(providerPattern, provider ?? '')) return false
  const pattern = rule.model
  return wildcardMatch(pattern, model ?? '') || wildcardMatch(pattern, `${provider ?? ''}/${model ?? ''}`)
}

/**
 * 在规则集中求当前是否高峰；返回第一个命中的活跃 period。
 * @param {Array} rules - normalizeConfig 后的规则数组。
 * @param {string} provider - 当前供应商。
 * @param {string} model - 当前模型名。
 * @param {Date|number} date - 判定时刻。
 * @param {string} fallbackTimeZone - 缺省时区。
 * @returns {object} { peak: boolean, ... }
 */
function peakStateAt(rules, provider, model, date, fallbackTimeZone) {
  const tzFallback = fallbackTimeZone || defaultTimeZone()
  const when = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(when.getTime())) throw new TypeError(`invalid date: ${String(date)}`)
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
    const rule = rules[ruleIndex]
    if (!matchesRule(rule, provider, model)) continue
    const timeZone = rule.timezone || tzFallback
    for (let periodIndex = 0; periodIndex < rule.periods.length; periodIndex += 1) {
      const period = rule.periods[periodIndex]
      const status = periodStatusAt(period, when, timeZone)
      if (!status.active) continue
      return {
        peak: true,
        provider,
        model,
        ruleIndex,
        periodIndex,
        rule,
        period,
        timeZone,
        nominalDay: status.nominalDay,
        endsAt: status.endsAt,
        occurrenceKey: [
          provider,
          model,
          rule.provider,
          rule.model,
          String(ruleIndex),
          String(periodIndex),
          status.nominalDay,
          timeZone,
        ].join('\u0000'),
      }
    }
  }
  return { peak: false, provider, model }
}

/**
 * 校验并归一化配置文件/接口载荷。
 * @param {unknown} input - 原始 JSON 值。
 * @param {string} fallbackTimeZone - timezone 缺省值。
 * @returns {object} 归一化配置。
 */
function normalizeConfig(input, fallbackTimeZone) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('peak-pricing config must be an object')
  }
  if (!Array.isArray(input.rules)) {
    throw new TypeError('peak-pricing config.rules must be an array')
  }
  const tzFallback = fallbackTimeZone || defaultTimeZone()
  assertValidTimeZone(tzFallback, 'fallbackTimeZone')
  const remindIntervalMinutes = normalizeNonNegativeNumber(
    input.remindIntervalMinutes, 15, 'remindIntervalMinutes')
  const promptTimeoutSeconds = normalizeNonNegativeNumber(
    input.promptTimeoutSeconds, 0, 'promptTimeoutSeconds')

  const rules = input.rules.map((rule, ruleIndex) => {
    const where = `rules[${ruleIndex}]`
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new TypeError(`${where} must be an object`)
    }
    let provider = rule.provider
    if (provider === undefined || provider === null) {
      provider = '*' // 缺省匹配所有供应商
    } else if (typeof provider !== 'string' || provider.trim() === '') {
      throw new TypeError(`${where}.provider must be a non-empty string`)
    }
    if (typeof rule.model !== 'string' || rule.model.trim() === '') {
      throw new TypeError(`${where}.model must be a non-empty string`)
    }
    let timezone = rule.timezone
    if (timezone === undefined) {
      timezone = tzFallback
    } else {
      if (typeof timezone !== 'string' || timezone.trim() === '') {
        throw new TypeError(`${where}.timezone must be a non-empty IANA time zone string`)
      }
      assertValidTimeZone(timezone, `${where}.timezone`)
    }
    if (!Array.isArray(rule.periods)) {
      throw new TypeError(`${where}.periods must be an array`)
    }

    const periods = rule.periods.map((period, periodIndex) => {
      const periodWhere = `${where}.periods[${periodIndex}]`
      if (typeof period !== 'object' || period === null || Array.isArray(period)) {
        throw new TypeError(`${periodWhere} must be an object`)
      }
      let days
      if (period.days !== undefined) {
        if (!Array.isArray(period.days)) {
          throw new TypeError(`${periodWhere}.days must be an array of day codes`)
        }
        const seen = new Set()
        days = period.days.map((day) => {
          if (typeof day !== 'string' || !DAY_SET.has(day)) {
            throw new TypeError(`${periodWhere}.days contains invalid day code: ${String(day)}`)
          }
          if (seen.has(day)) throw new TypeError(`${periodWhere}.days contains duplicate day: ${day}`)
          seen.add(day)
          return day
        })
      }
      if (typeof period.start !== 'string' || parseHm(period.start) === null) {
        throw new TypeError(`${periodWhere}.start must be "HH:mm"`)
      }
      if (typeof period.end !== 'string' || parseHm(period.end) === null) {
        throw new TypeError(`${periodWhere}.end must be "HH:mm"`)
      }
      const normalized = { start: period.start, end: period.end }
      if (days !== undefined) normalized.days = days
      return normalized
    })

    return {
      provider,
      model: rule.model,
      timezone,
      periods,
    }
  })

  return { rules, remindIntervalMinutes, promptTimeoutSeconds }
}

function normalizeNonNegativeNumber(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`peak-pricing config.${name} must be a non-negative number`)
  }
  return value
}

/** 人类可读的时段标签。 */
function periodLabel(period) {
  return `${period.start}–${period.end}`
}

/** 人类可读的星期过滤标签；缺省返回“每天”。 */
function daysLabel(days) {
  if (days === undefined || days === null) return '每天'
  if (days.length === 0) return '不生效'
  return days.join(', ')
}

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
 *   - 用共享 schedule 逻辑判断高峰/低谷：高峰时给 document.body 加
 *     dshpp-peak 类，把输入框旁模型选择器里的模型名染成橙色（低谷
 *     不显示任何标识，无感）；进出高峰时各弹一条自动消失的临时通知；
 *   - 拦截当前会话 InputShell.submit：高峰提交时调用 host 的
 *     /__dsh-peak-pricing/submit-confirm，由 ctx.userQuestions 在对话窗口
 *     中提问；选择“暂不开始”则不调用原 submit，草稿自然留在输入框。
 * ========================================================================= */

const CONFIG_URL = "/__dsh-peak-pricing/config";
const SUBMIT_CONFIRM_URL = "/__dsh-peak-pricing/submit-confirm";
const TICK_MS = 5000;
const CONFIG_TICKS = 6; // 每 30 秒重拉一次配置
const NOTICE_LIFETIME_MS = 8000;
/** 高峰时加到 document.body 上的类：CSS 据此把模型名染橙。 */
const PEAK_BODY_CLASS = "dshpp-peak";

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
  const unsubscribePeakClass = store.subscribe(syncPeakClass);

  function start() {
    if (disposed) return;
    onSessionsChanged();
    void refreshConfig();
    syncPeakClass();
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

  /** 把当前高峰状态镜像到 document.body 的类名上，驱动模型名染色 CSS。 */
  function syncPeakClass() {
    if (typeof document === "undefined" || document.body == null) return;
    const snapshot = store.getSnapshot();
    const active = !disposed
      && snapshot.configState === "ready"
      && snapshot.model !== null
      && snapshot.peak !== null
      && snapshot.peak.peak === true;
    document.body.classList.toggle(PEAK_BODY_CLASS, active);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    disposeSessions();
    unbindModel();
    unsubscribePeakClass();
    if (typeof document !== "undefined" && document.body != null) {
      document.body.classList.remove(PEAK_BODY_CLASS);
    }
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

/* ---- 进入/离开高峰的临时通知 ----
 * 常显状态不再用独立胶囊：高峰时模型选择器里的模型名直接染橙（见 CSS
 * 中 body.dshpp-peak 规则），低谷完全无感。这里只渲染进出高峰时弹出的
 * 自动消失通知。 */
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

  if (snapshot.notice === null) return null;
  return h(
    "div",
    { className: "dshpp-root" },
    h(
      "div",
      {
        className: `dshpp-notice dshpp-notice-${snapshot.notice.tone}`,
        role: "status",
      },
      snapshot.notice.text,
    ),
  );
}

/* ---- CSS ----
 * 模型名染色：composer 卡片内唯一的 aria-haspopup="menu" 按钮就是
 * ModelSelect 触发器（PermissionSelect 用 listbox、WorkspaceChip 在卡片外），
 * 其颜色只被模型名 span 继承（effort 与 chevron 各自有显式颜色）。 */
const CSS = `
body.dshpp-peak [data-composer-card] button[aria-haspopup="menu"]{color:var(--dsw-alias-state-warn-label,#e07b39);}
.dshpp-root{position:fixed;right:14px;bottom:12px;z-index:10000;pointer-events:none;font-family:var(--dsw-font-family,inherit);}
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

		return module.exports;
	}
});
