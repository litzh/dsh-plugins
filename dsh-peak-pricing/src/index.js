/**
 * dsh-peak-pricing · host 半区。
 *
 * 职责：
 *   1. 通过 DSH 标准的 settings 机制读取高峰规则与全局选项。配置段位于
 *      `~/.dsh/settings.yaml` 的 `peak-pricing:` 命名空间（由
 *      `@deepseek-ai/dsh-settings-file` 提供，设置页可视化写入）；cordis.patch.yml
 *      的 `config` 只作为组合 base（settings 未覆盖时的回退默认）。
 *   2. 提供 POST /__dsh-peak-pricing/submit-confirm：浏览器端在提交前
 *      调用此接口，由 host 通过 ctx.userQuestions 在当前会话的对话窗口
 *      中提问（继续提交 / 暂不开始），替代浏览器自定义模态弹窗。
 *   3. 在 `tools/execute` 瀑布中，于每个顶层工具调用真正执行前判断当前
 *      agent 实际使用的 provider/model 是否已进入高峰。判断依据是
 *      `agent.session.requestHeader().config`（本次 step 真正组装的模型
 *      路由），仅在还没有 request/header 时才回退到 agent.options。
 *      若进入高峰，则通过 `ctx.userQuestions` 在 Web GUI 弹出选择：
 *        继续执行 / 本次高峰不再提醒 / 暂停任务。
 *      超时（promptTimeoutSeconds > 0）自动继续；开启 autoContinueOnPeakEnd
 *      后，等待期间离开高峰也会自动继续。暂停通过返回一个带
 *      additionalContexts 的错误工具结果自然停止当前 turn，不 abort，
 *      现场（会话日志、inbox、草稿）完整保留，用户发新消息后继续。
 *
 * 只依赖 Node 内置模块与 cordis/schemastery/dsh-settings（peer 依赖），
 * link 安装时 realpath 后仍可正常加载。
 */
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DAY_CODES,
  daysLabel,
  defaultTimeZone,
  normalizeConfig,
  peakStateAt,
  periodLabel,
} from './schedule.js'

export const name = 'dsh-peak-pricing'
export const inject = ['webServer', 'tools', 'userQuestions', 'agents']

const ROUTE_PREFIX = '/__dsh-peak-pricing'
const ROUTE_SUBMIT_CONFIRM = `${ROUTE_PREFIX}/submit-confirm`

const NS = settingsNamespace('peak-pricing')

const OPT_CONTINUE = '继续执行'
const OPT_SUPPRESS = '本次高峰不再提醒'
const OPT_PAUSE = '暂停任务'
const OPT_SUBMIT = '继续提交'
const OPT_DEFER = '暂不开始'

/**
 * 高峰计价配置 schema。结构 + 类型 + 默认值交给 schemastery；HH:mm 格式、
 * IANA 时区有效性、provider/model 非空、数值非负等深度校验交给
 * normalizeConfig（作为 settings 的 validate 钩子）。
 */
export const Config = z.object({
  rules: z.array(z.object({
    provider: z.string(),
    model: z.string().required(),
    timezone: z.string(),
    periods: z.array(z.object({
      days: z.array(z.union(DAY_CODES)),
      start: z.string().required(),
      end: z.string().required(),
    })).required(),
  })).default([]),
  remindIntervalMinutes: z.number().default(15),
  promptTimeoutSeconds: z.number().default(0),
  autoContinueOnPeakEnd: z.boolean().default(false),
})

/**
 * 测试挂钩：自动继续轮询间隔（毫秒）。运行时保持默认即可，
 * 测试里可调小以快速触发“高峰结束自动继续”。
 */
export const internals = {
  autoContinuePollMs: 15_000,
}

/**
 * settings 写入的深度校验：normalizeConfig 抛错即拒绝这次写入。
 * 归一化结果这里不需要，仅借用它的校验语义（HH:mm、IANA、days、非负等）。
 */
function assertValidSettings(value) {
  normalizeConfig(value, defaultTimeZone())
}

/* ------------------------------------------------------------------ */
/* HTTP 提交确认接口                                                    */
/* ------------------------------------------------------------------ */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(body)
}

function readJsonBody(req, limit = 32 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let body = ''
    let settled = false
    req.setEncoding?.('utf8')
    req.on('data', (chunk) => {
      body += String(chunk)
      if (body.length > limit) {
        settled = true
        reject(new Error(`request body exceeds ${limit} bytes`))
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolvePromise(body === '' ? {} : JSON.parse(body))
      } catch (error) {
        reject(new Error(`request body is not valid JSON: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ */
/* 长任务运行中进入高峰的拦截                                          */
/* ------------------------------------------------------------------ */

/**
 * 每个 agent 的提醒状态；状态跟随 apply 实例，插件卸载/重载不会串味。
 * @param states - apply 实例的 agent 状态表。
 * @param agentId - agent 生命周期 id。
 */
function stateFor(states, agentId) {
  let state = states.get(agentId)
  if (state === undefined) {
    state = {
      lastPromptAt: undefined,
      lastPromptRouteKey: undefined,
      suppressedKey: null,
      paused: false,
      pauseContextSent: false,
    }
    states.set(agentId, state)
  }
  return state
}

function isRootAgent(ctx, agent) {
  try {
    return ctx.agents.roots().includes(agent)
  } catch {
    return true // agents service 异常时保持能力可用；工具仍由 agent 路由。
  }
}

/**
 * 本次 step 真正使用的 provider/model。
 *
 * DSH 中 Agent.options 只是 agent 创建/恢复时的 seed；会话内通过
 * `session.selectModel` 切换模型后，新选择会在下一次 prompt assembly 时
 * 快照并经 agent/request waterfall 写入 request/header。工具调用发生在其
 * 所属 step 的模型请求之后，因此 request/header.config 才是该工具调用
 * 实际计费路由；只有从未记录 request/header 时才回退 options。
 */
function agentRoute(agent) {
  let headerConfig
  try {
    headerConfig = typeof agent?.session?.requestHeader === 'function'
      ? agent.session.requestHeader()?.config
      : undefined
  } catch {
    headerConfig = undefined
  }
  const provider = typeof headerConfig?.provider === 'string' && headerConfig.provider.length > 0
    ? headerConfig.provider
    : agent?.options?.provider
  const model = typeof headerConfig?.model === 'string' && headerConfig.model.length > 0
    ? headerConfig.model
    : agent?.options?.model
  return {
    provider: String(provider ?? ''),
    model: String(model ?? ''),
  }
}

function modelLabel(agent) {
  const route = agentRoute(agent)
  return route.provider === '' ? route.model : `${route.provider}/${route.model}`
}

/**
 * 每个 agent 的串行提示门：并行工具调用只弹一次窗。
 * @param tails - apply 实例的提示门表。
 * @param agentId - agent 生命周期 id。
 * @param task - 需要串行执行的提示任务。
 */
function withPromptGate(tails, agentId, task) {
  const previous = tails.get(agentId) ?? Promise.resolve()
  const run = previous.then(task, task)
  tails.set(agentId, run)
  void run.finally(() => {
    if (tails.get(agentId) === run) tails.delete(agentId)
  })
  return run
}

function periodDetail(peak) {
  const lines = [
    `模型：${peak.provider === '' ? peak.model : `${peak.provider}/${peak.model}`}`,
    `时段：${periodLabel(peak.period)}（${peak.timeZone ?? '未知时区'}，${daysLabel(peak.period.days)}）`,
  ]
  return lines.join('\n')
}

function timeoutLine(timeoutSeconds) {
  return timeoutSeconds > 0
    ? `若 ${timeoutSeconds} 秒内未选择，将自动继续。`
    : '请选择后续操作；不选择会一直等待。'
}

function autoContinueLine(enabled) {
  return enabled ? '若在等待期间离开高峰时段，将自动继续。' : null
}

function runQuestion(agent, peak, timeoutSeconds, autoContinue) {
  return {
    id: 'peak-pricing-run',
    header: '高峰计价提醒',
    question: `${modelLabel(agent)} 已进入高峰时段，是否继续执行？`,
    detail: [periodDetail(peak), timeoutLine(timeoutSeconds), autoContinueLine(autoContinue)]
      .filter(line => line !== null).join('\n'),
    options: [
      {
        label: OPT_CONTINUE,
        description: '立即执行当前工具调用；运行中每隔一定时间会再次确认。',
      },
      {
        label: OPT_SUPPRESS,
        description: '本次高峰窗口内不再提醒，窗口结束后恢复确认。',
      },
      {
        label: OPT_PAUSE,
        description: '当前工具不执行，任务自然停止并保留现场；你发送新消息后继续。',
      },
    ],
  }
}

function submitQuestion(agent, peak, timeoutSeconds, autoContinue) {
  return {
    id: 'peak-pricing-submit',
    header: '高峰计价提醒',
    question: `${modelLabel(agent)} 正处于高峰计价时段，是否继续提交？`,
    detail: [periodDetail(peak), timeoutLine(timeoutSeconds), autoContinueLine(autoContinue)]
      .filter(line => line !== null).join('\n'),
    options: [
      {
        label: OPT_SUBMIT,
        description: '立即提交当前输入。',
      },
      {
        label: OPT_DEFER,
        description: '不提交；输入框草稿会原样保留。',
      },
    ],
  }
}

function parseAnswer(answer) {
  const item = Array.isArray(answer?.answers) ? answer.answers[0] : undefined
  return {
    selected: Array.isArray(item?.selected) ? item.selected[0] : undefined,
    custom: typeof item?.custom === 'string' ? item.custom : '',
  }
}

/**
 * 通过 ctx.userQuestions 提问，等待用户选择、超时，或（可选）高峰结束后自动继续。
 * @param autoContinueCheck - 可选；返回「是否仍处于高峰」的异步检查。
 *   提供后按 internals.autoContinuePollMs 轮询，离开高峰即取消提问并继续。
 * @returns {Promise<{kind: 'continue'|'pause'|'suppress'|'defer', reason?: string}>}
 */
async function askPeakQuestion(ctx, agent, question, timeoutSeconds, callerSignal, autoContinueCheck) {
  const controller = new AbortController()
  let timedOut = false
  let peakEnded = false
  let timer = null
  let poller = null

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason instanceof Error
      ? callerSignal.reason
      : new Error('peak-pricing prompt cancelled by tool call signal'))
  }
  if (callerSignal?.aborted) onCallerAbort()
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

  if (timeoutSeconds > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`peak-pricing prompt timed out after ${timeoutSeconds}s`))
    }, timeoutSeconds * 1000)
  }

  if (typeof autoContinueCheck === 'function') {
    let checking = false
    poller = setInterval(() => {
      if (checking || controller.signal.aborted) return
      checking = true
      void Promise.resolve()
        .then(autoContinueCheck)
        .then((stillPeak) => {
          if (stillPeak === false && !peakEnded) {
            peakEnded = true
            controller.abort(new Error('peak-pricing auto-continue: peak window ended'))
          }
        })
        .catch(() => {
          // 检查失败（如配置临时损坏）：保持等待，下一轮再试。
        })
        .finally(() => {
          checking = false
        })
    }, internals.autoContinuePollMs)
    poller.unref?.()
  }

  try {
    const answer = await ctx.userQuestions.ask({
      agent,
      signal: controller.signal,
      questions: [question],
    })
    if (peakEnded) return { kind: 'continue', reason: 'peak-ended' }
    if (timedOut) return { kind: 'continue', reason: 'timeout' }
    const { selected, custom } = parseAnswer(answer)
    if (question.id === 'peak-pricing-submit') {
      if (selected === OPT_DEFER || custom.includes('暂不')) return { kind: 'defer' }
      return { kind: 'continue' }
    }
    if (selected === OPT_PAUSE || custom.includes('暂停')) return { kind: 'pause' }
    if (selected === OPT_SUPPRESS || custom.includes('不再提醒')) return { kind: 'suppress' }
    return { kind: 'continue' }
  } catch (error) {
    // 高峰结束自动继续优先于其它取消原因。
    if (peakEnded) return { kind: 'continue', reason: 'peak-ended' }
    // 取消、provider 缺失或其它 UI 故障：宁可继续，也不悄悄挂起提交/工具调用。
    if (timedOut) return { kind: 'continue', reason: 'timeout' }
    return { kind: 'continue', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (poller !== null) clearInterval(poller)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}

async function handleSubmitConfirmRoute(ctx, source, req, res) {
  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message })
    return
  }

  const sessionId = payload?.sessionId
  const provider = typeof payload?.provider === 'string' ? payload.provider.trim() : ''
  const model = typeof payload?.model === 'string' ? payload.model.trim() : ''
  if (typeof sessionId !== 'string' || sessionId === '' || provider === '' || model === '') {
    sendJson(res, 400, { ok: false, error: 'sessionId, provider and model are required' })
    return
  }

  const agent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined
  if (agent === undefined || !isRootAgent(ctx, agent)) {
    // 会话/agent 不可用时宁可放行，不能把用户提交挂起。
    sendJson(res, 200, { ok: true, action: 'continue', reason: 'agent-unavailable' })
    return
  }

  let config
  try {
    config = source()
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message })
    return
  }

  let peak
  try {
    peak = peakStateAt(config.rules, provider, model, new Date())
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message })
    return
  }
  if (!peak.peak) {
    sendJson(res, 200, { ok: true, action: 'continue', reason: 'off-peak' })
    return
  }

  const timeoutSeconds = Math.max(0, config.promptTimeoutSeconds || 0)
  const autoContinue = config.autoContinueOnPeakEnd === true
    ? async () => {
      const latest = source()
      return peakStateAt(latest.rules, provider, model, new Date()).peak === true
    }
    : undefined
  const requestController = new AbortController()
  const onClientAbort = () => {
    requestController.abort(new Error('peak-pricing submit confirmation cancelled: client disconnected'))
  }
  if (req.aborted === true) onClientAbort()
  else req.once?.('aborted', onClientAbort)
  let decision
  try {
    decision = await askPeakQuestion(
      ctx,
      agent,
      submitQuestion(agent, peak, timeoutSeconds, config.autoContinueOnPeakEnd === true),
      timeoutSeconds,
      requestController.signal,
      autoContinue,
    )
  } finally {
    req.removeListener?.('aborted', onClientAbort)
  }
  if (decision.kind === 'defer') {
    sendJson(res, 200, { ok: true, action: 'defer', reason: decision.reason ?? 'deferred' })
    return
  }
  sendJson(res, 200, { ok: true, action: 'continue', reason: decision.reason ?? decision.kind })
}

async function decideForToolCall(ctx, source, exec, states, tails) {
  const agent = exec.agent
  const state = stateFor(states, agent.id)

  if (state.paused) return { kind: 'pause', peak: null }

  const config = source()
  const route = agentRoute(agent)
  const routeKey = `${route.provider}\u0000${route.model}`
  if (state.lastPromptRouteKey !== routeKey) {
    state.lastPromptRouteKey = routeKey
    state.lastPromptAt = undefined
  }
  const peak = peakStateAt(config.rules, route.provider, route.model, new Date())

  if (!peak.peak) {
    state.suppressedKey = null
    return { kind: 'continue', peak: null }
  }
  if (state.suppressedKey === peak.occurrenceKey) {
    return { kind: 'continue', peak, reason: 'suppressed' }
  }

  const remindIntervalMs = Math.max(0, config.remindIntervalMinutes || 0) * 60_000
  if (state.lastPromptAt !== undefined && Date.now() - state.lastPromptAt < remindIntervalMs) {
    return { kind: 'continue', peak, reason: 'cooldown' }
  }

  const timeoutSeconds = Math.max(0, config.promptTimeoutSeconds || 0)
  const autoContinue = config.autoContinueOnPeakEnd === true
    ? async () => {
      const latest = source()
      const latestRoute = agentRoute(agent)
      return peakStateAt(latest.rules, latestRoute.provider, latestRoute.model, new Date()).peak === true
    }
    : undefined
  const answer = await askPeakQuestion(
    ctx,
    agent,
    runQuestion(agent, peak, timeoutSeconds, config.autoContinueOnPeakEnd === true),
    timeoutSeconds,
    exec.signal,
    autoContinue,
  )
  if (answer.kind === 'pause') {
    state.paused = true
    // 用户恢复后仍在同一高峰窗口内时，冷却期内不再追问。
    state.lastPromptAt = Date.now()
    return { kind: 'pause', peak }
  }
  state.lastPromptAt = Date.now()
  if (answer.kind === 'suppress') state.suppressedKey = peak.occurrenceKey
  return { kind: 'continue', peak, reason: answer.kind }
}

function pauseContextMessage(peak, agent) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `[dsh-peak-pricing] 用户已暂停任务以避开 ${modelLabel(agent)} 的高峰时段。`
        + '请停止调用工具，保留当前现场，等待用户发送新消息后再继续。',
    }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-peak-pricing',
      form: 'notice',
      summary: '用户暂停任务以避开高峰时段',
    },
  }
}

function pausedToolResult(agent, state, peak) {
  const label = modelLabel(agent)
  const message = `peak-pricing pause: user paused ${label} before the next tool call`
  const result = {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
  if (peak !== null && !state.pauseContextSent) {
    state.pauseContextSent = true
    result.additionalContexts = [pauseContextMessage(peak, agent)]
  }
  return result
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  // schemastery 先补齐默认值，再深度校验组合 base（非法规则要 fail loud）。
  const config = Config(rawConfig ?? {})
  normalizeConfig(config, defaultTimeZone())

  // 当前生效配置来源：settings 存在时用其解析值，否则回退组合 base。
  // 读取时统一 normalizeConfig 归一化，保证 rules/全局项结构与旧版一致。
  let source = () => normalizeConfig(config, defaultTimeZone())
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (current) => {
      source = () => normalizeConfig(current(), defaultTimeZone())
    },
    onChange: () => {
      // 每次工具调用/提交确认都通过 source() 现读，无需在变更时重建派生状态。
    },
    validate: assertValidSettings,
  })

  const disposers = []
  const sessionStates = new Map()
  const promptTails = new Map()

  const routeRegistration = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      let pathname
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      try {
        if (pathname === ROUTE_SUBMIT_CONFIRM) {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          await handleSubmitConfirmRoute(ctx, source, req, res)
          return
        }
        res.writeHead(404)
        res.end()
      } catch (error) {
        ctx.logger?.error?.(error)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      }
    },
  })
  if (typeof routeRegistration === 'function') disposers.push(routeRegistration)

  disposers.push(ctx.on('tools/execute', async (exec, next) => {
    // 只在顶层、真实用户会话的 root agent 上拦截；嵌套/子 agent 没有 UI。
    if (exec.parent !== undefined || exec.agent === undefined) return next()
    const agent = exec.agent
    if (!isRootAgent(ctx, agent)) return next()

    const state = stateFor(sessionStates, agent.id)
    if (state.paused) return pausedToolResult(agent, state, null)

    let decision
    try {
      decision = await withPromptGate(promptTails, agent.id, () => decideForToolCall(ctx, source, exec, sessionStates, promptTails))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-peak-pricing] peak prompt failed, continuing tool call: %s',
        error instanceof Error ? error.message : String(error))
      return next()
    }

    if (decision.kind === 'pause') {
      return pausedToolResult(agent, state, decision.peak)
    }
    return next()
  }))

  // 用户主动发送新消息 = 明确恢复信号。
  disposers.push(ctx.on('agent/inbox/inserted', (payload) => {
    const message = payload?.message
    if (message?.source?.kind !== 'user') return
    const state = sessionStates.get(payload?.agent?.id)
    if (state !== undefined) {
      state.paused = false
      state.pauseContextSent = false
    }
  }))

  disposers.push(ctx.on('agent/disposed', (payload) => {
    if (payload?.agent?.id !== undefined) sessionStates.delete(payload.agent.id)
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.('[dsh-peak-pricing] dispose failed: %s',
          error instanceof Error ? error.message : String(error))
      }
    }
  }
}
