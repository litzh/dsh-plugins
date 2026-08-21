import { hostname } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'beacon'
const inject = ['tools']

const Config = z.object({
  /** beacon 面板地址。缺省读环境变量 BEACON_URL。 */
  url: z.string().default('http://localhost:7331'),
  /** 面板鉴权 token（Authorization: Bearer）。缺省读环境变量 BEACON_TOKEN。 */
  token: z.string().default(''),
  /** 事件来源标识。 */
  source: z.string().default('dsh'),
  /** 心跳间隔秒数（0 关闭）。心跳带 TTL，面板可据此发现进程崩溃/失联。 */
  heartbeatSeconds: z.number().default(60),
  /** 「等待确认」事件的 TTL 秒数（用户可能长时间不操作）。 */
  confirmTtlSeconds: z.number().default(600)
}).default({})

/** 需要上报为 warning 的危险命令模式 */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r)/,
  /\bsudo\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard/,
  /\b(kubectl|helm|terraform)\s+(apply|delete|destroy)\b/
]

const TIMEOUT_MS = 3000

const SEND_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sent: { type: 'boolean', required: true },
      id: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }
    }
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
}

/** 提取用户消息中的纯文本（拼接 text 块）。 */
function textOf(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function apply(ctx, config = {}) {
  const url = config.url || process.env.BEACON_URL || 'http://localhost:7331'
  const token = config.token || process.env.BEACON_TOKEN || ''
  const source = config.source ?? 'dsh'
  const heartbeatSeconds = config.heartbeatSeconds ?? 60
  const confirmTtl = config.confirmTtlSeconds ?? 600
  const host = hostname()
  const startTs = new Map() // agent -> 会话启动时间
  const pendingAck = new Map() // approvalId / callId -> beacon event id

  function authHeaders() {
    const h = { 'Content-Type': 'application/json' }
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }

  /** 上报一条事件；beacon 未运行或网络异常时静默失败。 */
  async function postEvent(ev) {
    try {
      const res = await fetch(`${url}/api/v1/events`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ hostname: host, ...ev }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!res.ok) return null
      const data = await res.json()
      return data.id ?? null
    } catch {
      return null
    }
  }

  const fire = (ev) => { void postEvent(ev) }

  /** ACK 一条已上报的事件（面板侧标记已处理）。 */
  async function ackEvent(id) {
    try {
      await fetch(`${url}/api/v1/events/${id}/ack`, {
        method: 'POST',
        headers: authHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch {
      /* ignore */
    }
  }

  /** 上报「等待确认」事件并登记待 ACK；返回登记键（失败为 null）。 */
  async function fireConfirm(key, title, body) {
    const id = await postEvent({ source, level: 'action_required', title, body, flash: true, ttl: confirmTtl })
    if (id) pendingAck.set(key, id)
    return id
  }

  /** 对已登记的确认事件做 ACK。 */
  function ackBy(key) {
    const id = pendingAck.get(key)
    if (!id) return
    pendingAck.delete(key)
    void ackEvent(id)
  }

  // 会话启动
  ctx.on('agent/session-start', ({ agent }) => {
    startTs.set(agent, Date.now())
    fire({ source, level: 'info', title: 'DSH 会话启动', body: `cwd: ${agent.session?.header?.cwd ?? '(未知)'}` })
  })

  // 用户提交了新任务
  ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message?.source?.kind !== 'user') return
    const text = textOf(message)
    if (!text) return
    fire({ source, level: 'info', title: '开始处理任务', body: text.length > 80 ? `${text.slice(0, 80)}…` : text })
  })

  // 危险工具调用前上报（不阻塞执行）；ask_user_question 等待期间上报「等待确认」并在结束后 ACK
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'bash') {
      const cmd = String(exec.arguments?.command ?? '')
      if (DANGEROUS_PATTERNS.some((p) => p.test(cmd))) {
        fire({
          source,
          level: 'warning',
          title: '执行危险命令',
          body: cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd
        })
      }
      return next()
    }
    if (exec.name === 'ask_user_question') {
      const questions = Array.isArray(exec.arguments?.questions) ? exec.arguments.questions : []
      const first = questions[0]?.question ?? ''
      await fireConfirm(`ask-${exec.callId}`, '等待你回答问题', first.length > 120 ? `${first.slice(0, 120)}…` : first)
      try {
        return await next()
      } finally {
        ackBy(`ask-${exec.callId}`)
      }
    }
    return next()
  })

  // 工具审批：approval/asked → 等待确认（action_required）；approval/decided → ACK
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'approval/asked') {
      const data = event.data ?? {}
      void fireConfirm(
        `approval-${data.id}`,
        `等待你确认工具：${data.toolName ?? '未知'}`,
        typeof data.reason === 'string' ? (data.reason.length > 120 ? `${data.reason.slice(0, 120)}…` : data.reason) : undefined
      )
      return
    }
    if (event.type === 'approval/decided') {
      ackBy(`approval-${event.data?.id}`)
    }
  })

  // agent 异常（如模型报错、本轮运行失败）。报 warning 而非 critical：
  // 这类错误不需要用户确认，critical 会成为活跃告警全屏闪烁且只能等 TTL 超时
  ctx.on('agent/error', ({ agent, error }) => {
    const message = error instanceof Error ? error.message : String(error)
    fire({
      source,
      level: 'warning',
      title: 'agent 执行异常',
      body: `session: ${agent.id}\n${message.length > 200 ? `${message.slice(0, 200)}…` : message}`
    })
  })

  // 工具执行失败
  ctx.on('tools/result', (exec, result) => {
    if (!result.isError) return
    const args = exec.arguments ?? {}
    const hint = typeof args.command === 'string'
      ? args.command.slice(0, 120)
      : typeof args.path === 'string' ? args.path : ''
    fire({ source, level: 'warning', title: `工具 ${exec.name} 执行失败`, body: hint })
  })

  // agent 完全空闲，等待用户输入
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const ts = startTs.get(agent)
    const elapsed = ts ? Math.round((Date.now() - ts) / 1000) : 0
    fire({
      source,
      level: 'info',
      title: '任务完成，等待输入',
      body: elapsed > 0 ? `本次会话已运行 ${elapsed}s` : undefined
    })
  })

  // 会话结束
  ctx.on('agent/disposed', ({ agent }) => {
    startTs.delete(agent)
    fire({ source, level: 'info', title: 'DSH 会话结束', body: `session: ${agent.id}` })
  })

  // 进程启动上报；心跳（TTL 过期即失联，面板可发现崩溃/异常重启）
  fire({ source, level: 'info', title: 'dsh 进程已启动', body: `host: ${host}` })
  let heartbeat = null
  if (heartbeatSeconds > 0) {
    heartbeat = setInterval(() => {
      fire({ source, level: 'info', title: '心跳', body: `host: ${host}`, ttl: Math.ceil(heartbeatSeconds * 1.5) })
    }, heartbeatSeconds * 1000)
    heartbeat.unref?.()
  }

  // 正常退出：尽力上报停止事件并清理心跳
  ctx.effect(() => async () => {
    if (heartbeat) clearInterval(heartbeat)
    await postEvent({ source, level: 'info', title: 'dsh 进程已停止', body: `host: ${host}` })
  }, 'beacon: lifecycle')

  // 手动发一条消息到 beacon（测试用）
  ctx.tools.register(defineTool({
    name: 'beacon_send',
    description: '手动发送一条消息到 beacon 监控面板，用于测试连通性。返回发送是否成功及事件 id。',
    parameters: {
      text: { type: 'string', required: true, description: '消息内容。' },
      level: {
        type: 'string',
        description: '事件级别：info | warning | critical | action_required，默认 info。'
      }
    },
    output: SEND_OUTPUT,
    timeoutMs: 10000,
    async execute(args) {
      const level = ['info', 'warning', 'critical', 'action_required'].includes(args.level) ? args.level : 'info'
      const id = await postEvent({
        source,
        level,
        title: args.text,
        flash: level === 'critical' || level === 'action_required',
        ttl: level === 'action_required' ? 120 : 0
      })
      return { sent: id !== null, id }
    }
  }))
}

export { Config, apply, inject, name }
