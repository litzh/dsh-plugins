// dsh-peak-pricing 核心逻辑测试：
//   1. 高峰时段纯逻辑（通配符、时区、跨午夜、星期过滤、全天）；
//   2. host 半区 tools/execute 拦截与 submit-confirm 接口（mock Context，
//      配置经 mock settings 服务注入，不依赖 DSH 进程）。
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  daysLabel,
  defaultTimeZone,
  matchesRule,
  normalizeConfig,
  parseHm,
  peakStateAt,
  periodLabel,
  wildcardMatch,
} from './src/schedule.js'
import * as plugin from './src/index.js'

const utc = (value) => new Date(`${value}Z`)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* 纯调度逻辑                                                          */
/* ------------------------------------------------------------------ */

test('wildcardMatch 支持 * 与 ?', () => {
  assert.equal(wildcardMatch('claude-*', 'claude-sonnet-4'), true)
  assert.equal(wildcardMatch('claude-?', 'claude-4'), true)
  assert.equal(wildcardMatch('claude-?', 'claude-44'), false)
  assert.equal(wildcardMatch('deepseek-chat', 'deepseek-chat'), true)
  assert.equal(wildcardMatch('deepseek-chat', 'deepseek-chat-x'), false)
})

test('normalizeConfig 填默认值并拒绝非法配置', () => {
  const config = normalizeConfig({
    rules: [{ provider: 'p', model: 'm', periods: [{ start: '09:00', end: '18:00' }] }],
  }, 'Asia/Shanghai')
  assert.equal(config.remindIntervalMinutes, 15)
  assert.equal(config.promptTimeoutSeconds, 0)
  assert.equal(config.rules[0].timezone, 'Asia/Shanghai')
  assert.equal(config.rules[0].periods[0].days, undefined)

  // provider 可省略，缺省为 '*'（匹配所有供应商）。
  const noProvider = normalizeConfig({
    rules: [{ model: 'm', periods: [{ start: '09:00', end: '18:00' }] }],
  })
  assert.equal(noProvider.rules[0].provider, '*')
  assert.equal(noProvider.autoContinueOnPeakEnd, false)
  assert.throws(
    () => normalizeConfig({ rules: [{ provider: '  ', model: 'm', periods: [{ start: '09:00', end: '18:00' }] }] }),
    /provider must be a non-empty string/,
  )
  assert.throws(
    () => normalizeConfig({ rules: [], autoContinueOnPeakEnd: 'yes' }),
    /autoContinueOnPeakEnd must be a boolean/,
  )

  assert.throws(() => normalizeConfig(null), /config must be an object/)
  assert.throws(() => normalizeConfig({}), /rules must be an array/)
  assert.throws(
    () => normalizeConfig({ rules: [{ provider: 'p', model: 'm', periods: [] }] }, 'No/Such_Zone'),
    /valid IANA time zone/,
  )
  assert.throws(
    () => normalizeConfig({ rules: [{ provider: 'p', model: 'm', periods: [{ start: '9:00', end: '18:00' }] }] }),
    /start must be "HH:mm"/,
  )
  assert.throws(
    () => normalizeConfig({ rules: [{ provider: 'p', model: 'm', periods: [{ start: '09:00', end: '18:00', days: ['mon', 'monday'] }] }] }),
    /invalid day code/,
  )
  assert.throws(
    () => normalizeConfig({ rules: [], remindIntervalMinutes: -1 }),
    /non-negative number/,
  )
})

test('模型匹配：provider 精确，model 支持裸名与 provider/model 全名', () => {
  const rule = { provider: 'anthropic', model: 'claude-*' }
  assert.equal(matchesRule(rule, 'anthropic', 'claude-sonnet-4'), true)
  assert.equal(matchesRule({ ...rule, model: 'anthropic/claude-*' }, 'anthropic', 'claude-sonnet-4'), true)
  assert.equal(matchesRule(rule, 'openai', 'claude-sonnet-4'), false)
  assert.equal(matchesRule(rule, 'anthropic', 'gpt-5'), false)
})

test('同天时段按规则时区判定，start 含 end 不含', () => {
  const config = normalizeConfig({
    rules: [{
      provider: 'p',
      model: 'm',
      timezone: 'Asia/Shanghai',
      periods: [{ start: '09:00', end: '18:00' }],
    }],
  })
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T00:59')).peak, false)
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T01:00')).peak, true)
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T09:59')).peak, true)
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T10:00')).peak, false)
})

test('跨午夜时段按 start 所在日过滤星期', () => {
  const config = normalizeConfig({
    rules: [{
      provider: 'p',
      model: 'm',
      timezone: 'Asia/Shanghai',
      periods: [{ days: ['mon'], start: '22:00', end: '02:00' }],
    }],
  })
  // 2025-01-06 是周一；上海时区周一 22:00 = 14:00Z，周二 02:00 = 18:00Z。
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T13:59')).peak, false)
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T14:00')).peak, true)
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T17:59')).peak, true)
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T18:00')).peak, false)
  // 周二晚不再属于“周一的跨午夜时段”。
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-07T14:00')).peak, false)
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-06T17:00')).nominalDay, '2025-01-06')
})

test('start == end 为全天并遵守 days 过滤', () => {
  const config = normalizeConfig({
    rules: [{
      provider: 'p',
      model: 'm',
      timezone: 'UTC',
      periods: [{ days: ['sat', 'sun'], start: '00:00', end: '00:00' }],
    }],
  })
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-11T00:00')).peak, true) // Sat
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-12T23:59')).peak, true) // Sun
  assert.equal(peakStateAt(config.rules, 'p', 'm', utc('2025-01-13T00:00')).peak, false) // Mon
})

test('periodLabel / daysLabel / parseHm 基础行为', () => {
  assert.equal(parseHm('00:00'), 0)
  assert.equal(parseHm('23:59'), 23 * 60 + 59)
  assert.equal(parseHm('24:00'), null)
  assert.equal(periodLabel({ start: '22:00', end: '02:00' }), '22:00–02:00')
  assert.equal(daysLabel(undefined), '每天')
  assert.equal(daysLabel(['mon', 'fri']), 'mon, fri')
  assert.equal(daysLabel([]), '不生效')
})

/* ------------------------------------------------------------------ */
/* host 半区 mock                                                      */
/* ------------------------------------------------------------------ */

/**
 * 构造带 mock settings 服务的 Context。
 * `initialConfig` 作为生效配置的初始值；测试通过 `ctx.setConfig(next)`
 * 运行中改配置（模拟 settings 热重载），host 侧 source() 现读即生效。
 */
function createMockCts(agent, initialConfig = { rules: [] }) {
  const listeners = new Map()
  let current = normalizeConfig(initialConfig, defaultTimeZone())

  const mockScope = {
    get() {
      return current
    },
    watch() {
      return () => {}
    },
    update() {
      return Promise.resolve()
    },
    replace(section) {
      current = normalizeConfig(section, defaultTimeZone())
      return Promise.resolve()
    },
  }

  const ctx = {
    logger: { warn() {}, error() {} },
    webServer: {
      register(route) {
        ctx.route = route
        return () => {}
      },
    },
    on(name, listener) {
      let bucket = listeners.get(name)
      if (bucket === undefined) {
        bucket = []
        listeners.set(name, bucket)
      }
      bucket.push(listener)
      return () => {
        const index = bucket.indexOf(listener)
        if (index >= 0) bucket.splice(index, 1)
      }
    },
    listeners,
    userQuestions: {
      async ask() {
        return { answers: [{ id: 'peak-pricing-run', selected: ['继续执行'] }] }
      },
    },
    agents: {
      get(id) {
        return id === agent.id ? agent : undefined
      },
      roots() {
        return [agent]
      },
    },
    // 插件会调用 ctx.inject(['settings'], cb)；这里模拟 settings 服务
    // 已激活，installSection 将 source 指向可变的 mockScope。
    inject(_selection, callback) {
      const sctx = Object.create(ctx)
      sctx.settings = {
        installSection(_owner, _ns, _schema, _entry, hooks) {
          hooks.setSource(() => mockScope.get())
          hooks.onChange()
        },
      }
      sctx.effect = (fn) => {
        fn()
        return () => {}
      }
      callback(sctx)
      return () => {}
    },
    /** 测试挂钩：运行中改变生效配置。 */
    setConfig(next) {
      current = normalizeConfig(next, defaultTimeZone())
    },
  }
  return ctx
}

function mockAgent(id, provider = 'deepseek-official', model = 'deepseek-chat', requestConfig) {
  return {
    id,
    options: { provider, model },
    session: {
      requestHeader() {
        return requestConfig === undefined ? undefined : { config: requestConfig }
      },
    },
  }
}

async function callSubmitConfirmRoute(ctx, payload) {
  let body = ''
  let status = 0
  const req = Readable.from([JSON.stringify(payload)])
  req.method = 'POST'
  req.url = '/__dsh-peak-pricing/submit-confirm'
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      body = typeof chunk === 'string' ? chunk : ''
    },
  }
  await ctx.route.handler(req, res)
  return { status, body: JSON.parse(body) }
}

/* ------------------------------------------------------------------ */
/* host 半区行为                                                       */
/* ------------------------------------------------------------------ */

test('autoContinueOnPeakEnd：提问等待期间离开高峰自动继续', async () => {
  const previousPoll = plugin.internals.autoContinuePollMs
  plugin.internals.autoContinuePollMs = 20
  try {
    const agent = mockAgent('auto-continue-agent')
    const ctx = createMockCts(agent, {
      rules: [{
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        timezone: 'UTC',
        periods: [{ start: '00:00', end: '00:00' }],
      }],
      autoContinueOnPeakEnd: true,
      promptTimeoutSeconds: 0,
    })
    let asks = 0
    ctx.userQuestions.ask = ({ signal }) => {
      asks += 1
      return new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason ?? new Error('aborted'))
        else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
      })
    }
    const dispose = plugin.apply(ctx, {})
    const listener = ctx.listeners.get('tools/execute')[0]
    const exec = { parent: undefined, agent, signal: new AbortController().signal }

    let nextCalls = 0
    const pending = listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
    await delay(80)
    assert.equal(asks, 1, '高峰内应先提问')
    assert.equal(nextCalls, 0, '提问期间不得执行工具')

    // 用户不在时高峰结束（这里以规则被清空模拟）：提问被取消，自动继续。
    ctx.setConfig({ rules: [], autoContinueOnPeakEnd: true })
    await pending
    assert.equal(nextCalls, 1, '离开高峰后应自动继续执行工具')

    dispose()
  } finally {
    plugin.internals.autoContinuePollMs = previousPoll
  }
})

test('autoContinueOnPeakEnd 关闭时：离开高峰不干预，提问继续等待', async () => {
  const previousPoll = plugin.internals.autoContinuePollMs
  plugin.internals.autoContinuePollMs = 20
  try {
    const agent = mockAgent('no-auto-continue-agent')
    const ctx = createMockCts(agent, {
      rules: [{
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        timezone: 'UTC',
        periods: [{ start: '00:00', end: '00:00' }],
      }],
      promptTimeoutSeconds: 0,
    })
    ctx.userQuestions.ask = async () => {
      // 模拟用户稍后回来选择「继续执行」。
      await delay(120)
      return { answers: [{ id: 'peak-pricing-run', selected: ['继续执行'] }] }
    }
    const dispose = plugin.apply(ctx, {})
    const listener = ctx.listeners.get('tools/execute')[0]
    const exec = { parent: undefined, agent, signal: new AbortController().signal }

    let nextCalls = 0
    const pending = listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
    await delay(40)
    ctx.setConfig({ rules: [] })
    await pending
    assert.equal(nextCalls, 1, '用户选择继续后正常执行')
    // 再触发一次：离开高峰后不再提问。
    await listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
    assert.equal(nextCalls, 2)

    dispose()
  } finally {
    plugin.internals.autoContinuePollMs = previousPoll
  }
})

test('运行中进入高峰：询问一次，继续则调用 next；“不再提醒”抑制同一窗口', async () => {
  const agent = mockAgent('suppress-agent')
  const ctx = createMockCts(agent, {
    rules: [{
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timezone: 'UTC',
      periods: [{ start: '00:00', end: '00:00' }],
    }],
    remindIntervalMinutes: 15,
    promptTimeoutSeconds: 0,
  })
  let asks = 0
  ctx.userQuestions.ask = async (request) => {
    asks += 1
    assert.equal(request.questions[0].options.length, 3)
    assert.match(request.questions[0].detail, /UTC/, '时段文案应包含规则时区')
    assert.doesNotMatch(request.questions[0].detail, /undefined/, '时段文案不得出现 undefined')
    return { answers: [{ id: request.questions[0].id, selected: ['本次高峰不再提醒'] }] }
  }
  const dispose = plugin.apply(ctx, {})
  const listener = ctx.listeners.get('tools/execute')[0]
  const exec = { parent: undefined, agent, signal: new AbortController().signal }

  let nextCalls = 0
  const first = await listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
  assert.equal(first.isError, false)
  assert.equal(nextCalls, 1)
  assert.equal(asks, 1)

  const second = await listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
  assert.equal(second.isError, false)
  assert.equal(nextCalls, 2)
  assert.equal(asks, 1, '同一 occurrence 不应重复询问')

  dispose()
})

test('运行中进入高峰：暂停返回错误工具结果并保留现场，新用户消息后恢复', async () => {
  const agent = mockAgent('pause-agent')
  const ctx = createMockCts(agent, {
    rules: [{
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timezone: 'UTC',
      periods: [{ start: '00:00', end: '00:00' }],
    }],
    promptTimeoutSeconds: 0,
  })
  let asks = 0
  ctx.userQuestions.ask = async () => {
    asks += 1
    return { answers: [{ id: 'peak-pricing-run', selected: ['暂停任务'] }] }
  }
  const dispose = plugin.apply(ctx, {})
  const listener = ctx.listeners.get('tools/execute')[0]
  const exec = { parent: undefined, agent, signal: new AbortController().signal }

  let nextCalls = 0
  const first = await listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
  assert.equal(nextCalls, 0, '暂停时不得执行工具')
  assert.equal(first.isError, true)
  assert.equal(first.error.message.includes('pause'), true)
  assert.equal(Array.isArray(first.additionalContexts), true)
  assert.equal(first.additionalContexts[0].source.kind, 'plugin')

  const second = await listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
  assert.equal(nextCalls, 0, '同一 turn 的后续工具调用也应暂停')
  assert.equal(second.isError, true)
  assert.equal(asks, 1, '暂停状态不应重复弹窗')

  // 用户发送新消息是明确恢复信号。
  const inserted = ctx.listeners.get('agent/inbox/inserted')[0]
  inserted({ agent, message: { source: { kind: 'user' } } })
  const third = await listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
  assert.equal(nextCalls, 1)
  assert.equal(third.isError, false)

  dispose()
})

test('非根 agent 与嵌套工具调用不拦截', async () => {
  const parent = mockAgent('parent-agent')
  const child = mockAgent('child-agent')
  const ctx = createMockCts(parent, {
    rules: [{
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timezone: 'UTC',
      periods: [{ start: '00:00', end: '00:00' }],
    }],
  })
  ctx.agents.roots = () => [parent]
  let asks = 0
  ctx.userQuestions.ask = async () => { asks += 1; return { answers: [] } }
  const dispose = plugin.apply(ctx, {})
  const listener = ctx.listeners.get('tools/execute')[0]
  let nextCalls = 0

  await listener({ parent: 'token', agent: parent, signal: new AbortController().signal }, async () => { nextCalls += 1 })
  await listener({ parent: undefined, agent: child, signal: new AbortController().signal }, async () => { nextCalls += 1 })
  assert.equal(nextCalls, 2)
  assert.equal(asks, 0)

  dispose()
})

test('promptTimeoutSeconds > 0：超时后自动继续', async () => {
  const agent = mockAgent('timeout-agent')
  const ctx = createMockCts(agent, {
    rules: [{
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timezone: 'UTC',
      periods: [{ start: '00:00', end: '00:00' }],
    }],
    promptTimeoutSeconds: 0.05,
  })
  let asks = 0
  ctx.userQuestions.ask = (request) => new Promise((_resolve, reject) => {
    asks += 1
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  })
  const dispose = plugin.apply(ctx, {})
  const listener = ctx.listeners.get('tools/execute')[0]
  const exec = { parent: undefined, agent, signal: new AbortController().signal }
  let nextCalls = 0
  const startedAt = Date.now()
  await listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
  assert.equal(nextCalls, 1)
  assert.equal(asks, 1)
  assert.ok(Date.now() - startedAt >= 30, '应等待超时后自动继续')

  dispose()
})

test('remindIntervalMinutes 冷却：继续后间隔内不再询问', async () => {
  const agent = mockAgent('cooldown-agent')
  const ctx = createMockCts(agent, {
    rules: [{
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timezone: 'UTC',
      periods: [{ start: '00:00', end: '00:00' }],
    }],
    remindIntervalMinutes: 15,
  })
  let asks = 0
  ctx.userQuestions.ask = async () => {
    asks += 1
    return { answers: [{ id: 'peak-pricing-run', selected: ['继续执行'] }] }
  }
  const dispose = plugin.apply(ctx, {})
  const listener = ctx.listeners.get('tools/execute')[0]
  const exec = { parent: undefined, agent, signal: new AbortController().signal }
  let nextCalls = 0
  await listener(exec, async () => { nextCalls += 1 })
  await listener(exec, async () => { nextCalls += 1 })
  assert.equal(nextCalls, 2)
  assert.equal(asks, 1)

  dispose()
})

test('运行中高峰判断使用 request/header 的实际模型，而不是 AgentOptions seed', async () => {
  const agent = mockAgent('switch-agent', 'deepseek-official', 'deepseek-chat', {
    provider: 'opencode-go',
    model: 'deepseek-v4-pro',
  })
  const ctx = createMockCts(agent, {
    rules: [{
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timezone: 'UTC',
      periods: [{ start: '00:00', end: '00:00' }],
    }],
  })
  let asks = 0
  ctx.userQuestions.ask = async () => { asks += 1; return { answers: [] } }
  const dispose = plugin.apply(ctx, {})
  const listener = ctx.listeners.get('tools/execute')[0]
  const exec = { parent: undefined, agent, signal: new AbortController().signal }
  let nextCalls = 0
  await listener(exec, async () => { nextCalls += 1; return { isError: false, content: [] } })
  assert.equal(nextCalls, 1)
  assert.equal(asks, 0, '新模型处于低谷时不得用旧 AgentOptions 误判为高峰')

  dispose()
})

test('提交确认接口通过 userQuestions 提问：暂不开始返回 defer，非高峰不提问', async () => {
  const agent = mockAgent('submit-route-agent')
  const ctx = createMockCts(agent, {
    rules: [{
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timezone: 'UTC',
      periods: [{ start: '00:00', end: '00:00' }],
    }],
    promptTimeoutSeconds: 0,
  })
  let asks = 0
  ctx.userQuestions.ask = async (request) => {
    asks += 1
    assert.equal(request.agent, agent)
    assert.equal(request.questions[0].id, 'peak-pricing-submit')
    assert.deepEqual(request.questions[0].options.map(option => option.label), ['继续提交', '暂不开始'])
    return { answers: [{ id: request.questions[0].id, selected: ['暂不开始'] }] }
  }
  const dispose = plugin.apply(ctx, {})

  const defer = await callSubmitConfirmRoute(ctx, {
    sessionId: 'submit-route-agent',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
  })
  assert.equal(defer.status, 200)
  assert.equal(defer.body.ok, true)
  assert.equal(defer.body.action, 'defer')
  assert.equal(asks, 1)

  const offPeak = await callSubmitConfirmRoute(ctx, {
    sessionId: 'submit-route-agent',
    provider: 'opencode-go',
    model: 'deepseek-v4-pro',
  })
  assert.equal(offPeak.status, 200)
  assert.equal(offPeak.body.action, 'continue')
  assert.equal(offPeak.body.reason, 'off-peak')
  assert.equal(asks, 1, '低谷模型不应再次提问')

  dispose()
})
