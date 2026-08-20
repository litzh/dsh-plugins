/**
 * dsh-peak-pricing · host 半区。
 *
 * 职责：
 *   1. 读取 ~/.dsh/peak-pricing.json（遵循 $DSH_HOME）并注册查询接口：
 *      GET /__dsh-peak-pricing/config —— 返回归一化后的高峰期定义。
 *   2. 提供 POST /__dsh-peak-pricing/submit-confirm：浏览器端在提交前
 *      调用此接口，由 host 通过 ctx.userQuestions 在当前会话的对话窗口
 *      中提问（继续提交 / 暂不开始），替代浏览器自定义模态弹窗。
 *   3. 在 `tools/execute` 瀑布中，于每个顶层工具调用真正执行前判断当前
 *      agent 实际使用的 provider/model 是否已进入高峰。判断依据是
 *      `agent.session.requestHeader().config`（本次 step 真正组装的模型
 *      路由），仅在还没有 request/header 时才回退到 agent.options。
 *      若进入高峰，则通过 `ctx.userQuestions` 在 Web GUI 弹出选择：
 *        继续执行 / 本次高峰不再提醒 / 暂停任务。
 *      超时（promptTimeoutSeconds > 0）自动继续；暂停通过返回一个带
 *      additionalContexts 的错误工具结果自然停止当前 turn，不 abort，
 *      现场（会话日志、inbox、草稿）完整保留，用户发新消息后继续。
 *
 * 只依赖 Node 内置模块，link 安装时 realpath 后仍可正常加载。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  daysLabel,
  defaultTimeZone,
  normalizeConfig,
  peakStateAt,
  periodLabel,
} from './schedule.js'

export const name = 'dsh-peak-pricing'
export const inject = ['webServer', 'tools', 'userQuestions', 'agents']

const ROUTE_PREFIX = '/__dsh-peak-pricing'
const ROUTE_CONFIG = `${ROUTE_PREFIX}/config`
const ROUTE_SUBMIT_CONFIRM = `${ROUTE_PREFIX}/submit-confirm`
const CONFIG_BASENAME = 'peak-pricing.json'
const DSH_HOME_ENV = 'DSH_HOME'
const DSH_HOME_DIR_NAME = '.dsh'

const OPT_CONTINUE = '继续执行'
const OPT_SUPPRESS = '本次高峰不再提醒'
const OPT_PAUSE = '暂停任务'
const OPT_SUBMIT = '继续提交'
const OPT_DEFER = '暂不开始'

const EMPTY_CONFIG = normalizeConfig({ rules: [] }, defaultTimeZone())

/* ------------------------------------------------------------------ */
/* 配置文件路径与读取                                                  */
/* ------------------------------------------------------------------ */

function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function configPath() {
  const fromEnv = process.env[DSH_HOME_ENV]
  const base = fromEnv !== void 0 && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), DSH_HOME_DIR_NAME)
  return join(resolve(expandHomePath(base)), CONFIG_BASENAME)
}

async function readConfigDocument() {
  const path = configPath()
  let raw
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { present: false, path, config: EMPTY_CONFIG }
    }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`peak-pricing config ${path} is not valid JSON: ${error.message}`, { cause: error })
  }
  return {
    present: true,
    path,
    config: normalizeConfig(parsed, defaultTimeZone()),
  }
}

/** 供调度器使用的轻量缓存：文件 mtime/size 不变时复用上次成功解析结果。 */
let runtimeCache = null

async function runtimeConfig() {
  const path = configPath()
  let stat
  try {
    stat = await fs.stat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      runtimeCache = { path, mtimeMs: 0, size: -1, present: false, config: EMPTY_CONFIG }
      return runtimeCache.config
    }
    throw error
  }
  if (runtimeCache !== null && runtimeCache.path === path
    && runtimeCache.mtimeMs === stat.mtimeMs && runtimeCache.size === stat.size) {
    return runtimeCache.config
  }
  try {
    const document = await readConfigDocument()
    runtimeCache = {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      present: document.present,
      config: document.config,
    }
  } catch (error) {
    // 配置损坏时保留最后一次成功值，不让长任务被一个临时坏文件打断。
    runtimeCache = {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      present: true,
      config: runtimeCache?.config ?? EMPTY_CONFIG,
    }
    throw error
  }
  return runtimeCache.config
}

/* ------------------------------------------------------------------ */
/* HTTP 查询接口                                                       */
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

async function handleConfigRoute(res) {
  try {
    const document = await readConfigDocument()
    const config = document.config
    sendJson(res, 200, {
      ok: true,
      present: document.present,
      path: document.path,
      rules: config.rules,
      remindIntervalMinutes: config.remindIntervalMinutes,
      promptTimeoutSeconds: config.promptTimeoutSeconds,
    })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message })
  }
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
    `时段：${periodLabel(peak.period)}（${peak.timezone}，${daysLabel(peak.period.days)}）`,
  ]
  return lines.join('\n')
}

function timeoutLine(timeoutSeconds) {
  return timeoutSeconds > 0
    ? `若 ${timeoutSeconds} 秒内未选择，将自动继续。`
    : '请选择后续操作；不选择会一直等待。'
}

function runQuestion(agent, peak, timeoutSeconds) {
  return {
    id: 'peak-pricing-run',
    header: '高峰计价提醒',
    question: `${modelLabel(agent)} 已进入高峰时段，是否继续执行？`,
    detail: [periodDetail(peak), timeoutLine(timeoutSeconds)].join('\n'),
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

function submitQuestion(agent, peak, timeoutSeconds) {
  return {
    id: 'peak-pricing-submit',
    header: '高峰计价提醒',
    question: `${modelLabel(agent)} 正处于高峰计价时段，是否继续提交？`,
    detail: [periodDetail(peak), timeoutLine(timeoutSeconds)].join('\n'),
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
 * 通过 ctx.userQuestions 提问，等待用户选择或超时。
 * @returns {Promise<{kind: 'continue'|'pause'|'suppress'|'defer', reason?: string}>}
 */
async function askPeakQuestion(ctx, agent, question, timeoutSeconds, callerSignal) {
  const controller = new AbortController()
  let timedOut = false
  let timer = null

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

  try {
    const answer = await ctx.userQuestions.ask({
      agent,
      signal: controller.signal,
      questions: [question],
    })
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
    // 取消、provider 缺失或其它 UI 故障：宁可继续，也不悄悄挂起提交/工具调用。
    if (timedOut) return { kind: 'continue', reason: 'timeout' }
    return { kind: 'continue', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer !== null) clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}

async function handleSubmitConfirmRoute(ctx, req, res) {
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
    config = await runtimeConfig()
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
      submitQuestion(agent, peak, timeoutSeconds),
      timeoutSeconds,
      requestController.signal,
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

async function decideForToolCall(ctx, exec, states, tails) {
  const agent = exec.agent
  const state = stateFor(states, agent.id)

  if (state.paused) return { kind: 'pause', peak: null }

  const config = await runtimeConfig()
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
  const answer = await askPeakQuestion(
    ctx,
    agent,
    runQuestion(agent, peak, timeoutSeconds),
    timeoutSeconds,
    exec.signal,
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

export function apply(ctx) {
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
        if (pathname === ROUTE_CONFIG) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405)
            res.end()
            return
          }
          await handleConfigRoute(res)
          return
        }
        if (pathname === ROUTE_SUBMIT_CONFIRM) {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          await handleSubmitConfirmRoute(ctx, req, res)
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
      decision = await withPromptGate(promptTails, agent.id, () => decideForToolCall(ctx, exec, sessionStates, promptTails))
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
