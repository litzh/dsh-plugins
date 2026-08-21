// dsh-beacon 核心逻辑测试：stub fetch 捕获上报与 ACK，mock ctx 验证各事件的映射与过滤。
import * as plugin from './lib/index.js'

const posted = []
const acked = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const ackMatch = url.match(/\/api\/v1\/events\/(.+)\/ack$/)
  if (ackMatch) {
    acked.push(ackMatch[1])
    return { ok: true, json: async () => ({}) }
  }
  posted.push({ url, body: JSON.parse(init.body), headers: init.headers })
  return { ok: true, json: async () => ({ id: `evt-${posted.length}` }) }
}

const handlers = new Map()
const tools = new Map()
const effects = []
const ctx = {
  on(event, fn) { handlers.set(event, fn) },
  tools: { register(def) { tools.set(def.name, def) } },
  effect(fn) { effects.push(fn) }
}

const agent = { id: 'sess-1', session: { header: { cwd: '/tmp/work' } } }

const assert = (cond, msg) => { if (!cond) { console.error('✗ FAIL:', msg); process.exitCode = 1 } else console.log('✓', msg) }

// 关闭心跳，避免定时器干扰测试进程
plugin.apply(ctx, { url: 'http://beacon.test', token: 'tok', source: 'dsh-test', heartbeatSeconds: 0 })

// 进程启动
assert(posted.length === 1 && posted[0].body.title === 'dsh 进程已启动', '进程启动已上报')

// 会话启动
handlers.get('agent/session-start')({ agent })
assert(posted.length === 2 && posted[1].body.title === 'DSH 会话启动', '会话启动已上报')
assert(posted[1].body.body === 'cwd: /tmp/work', '上报带 cwd')
assert(posted[1].headers.Authorization === 'Bearer tok', '携带 token')

// 用户 prompt
handlers.get('agent/inbox/inserted')({
  agent,
  message: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修复这个 bug' }] }
})
assert(posted.length === 3 && posted[2].body.title === '开始处理任务', '用户 prompt 已上报')

// 非用户来源（插件注入）不上报
handlers.get('agent/inbox/inserted')({
  agent,
  message: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '系统上下文' }] }
})
assert(posted.length === 3, '插件来源消息不上报')

// 危险命令前置上报（waterfall 放行）
{
  const next = async () => 'dispatch-result'
  const result = await handlers.get('tools/execute')(
    { name: 'bash', arguments: { command: 'git push origin master' }, callId: 'c1' }, next)
  assert(result === 'dispatch-result', 'tools/execute 正常放行')
  const danger = posted[posted.length - 1]
  assert(danger.body.level === 'warning' && danger.body.title === '执行危险命令', '危险命令已上报')
}

// 普通命令不上报
{
  const before = posted.length
  await handlers.get('tools/execute')({ name: 'bash', arguments: { command: 'ls -la' }, callId: 'c2' }, async () => null)
  assert(posted.length === before, '普通命令不上报')
}

// ask_user_question：等待期间上报 action_required，结束后 ACK
{
  let release
  const gate = new Promise((resolve) => { release = () => resolve('answered') })
  const pending = handlers.get('tools/execute')(
    { name: 'ask_user_question', arguments: { questions: [{ id: 'q1', question: '确认删除？' }] }, callId: 'ask-1' },
    () => gate)
  await new Promise((resolve) => setImmediate(resolve))
  const confirm = posted[posted.length - 1]
  assert(confirm.body.level === 'action_required' && confirm.body.title === '等待你回答问题', '提问等待已上报 action_required')
  assert(confirm.body.flash === true && confirm.body.ttl === 600, '提问等待带 flash 与 ttl')
  assert(confirm.body.body.includes('确认删除？'), '提问等待带问题摘要')
  release()
  const result = await pending
  assert(result === 'answered', '提问调用正常返回')
  await new Promise((resolve) => setImmediate(resolve))
  assert(acked.length === 1, '提问结束后已 ACK')
}

// 工具审批：approval/asked → action_required；approval/decided → ACK
{
  const before = acked.length
  handlers.get('session/event')(null, {
    type: 'approval/asked',
    data: { id: 'ap-1', toolName: 'bash', reason: '需要写权限' }
  })
  await new Promise((resolve) => setImmediate(resolve))
  const confirm = posted[posted.length - 1]
  assert(confirm.body.level === 'action_required' && confirm.body.title.includes('bash'), '审批等待已上报 action_required')
  handlers.get('session/event')(null, { type: 'approval/decided', data: { id: 'ap-1', outcome: 'allowed-once' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert(acked.length === before + 1, '审批结果后已 ACK')
}

// agent 异常（报 warning，不进活跃告警/无需 ACK）
{
  handlers.get('agent/error')({ agent, turn: 1, step: 1, error: new Error('模型服务超时') })
  const last = posted[posted.length - 1]
  assert(last.body.level === 'warning' && last.body.title === 'agent 执行异常', 'agent 异常已上报 warning')
  assert(!last.body.flash, 'agent 异常不闪烁')
  assert(last.body.body.includes('模型服务超时'), '异常上报带错误信息')
}

// 工具失败上报
handlers.get('tools/result')(
  { name: 'bash', arguments: { command: 'kubectl apply -f x.yaml' } },
  { isError: true })
assert(posted.some((p) => p.body.title === '工具 bash 执行失败'), '工具失败已上报')

// 工具成功不上报
{
  const before = posted.length
  handlers.get('tools/result')({ name: 'read', arguments: {} }, { isError: false })
  assert(posted.length === before, '工具成功不上报')
}

// 空闲（任务完成）
handlers.get('agent/status')({ agent, status: 'idle' })
assert(posted.some((p) => p.body.title === '任务完成，等待输入'), '空闲已上报')

// running 不上报
{
  const before = posted.length
  handlers.get('agent/status')({ agent, status: 'running' })
  assert(posted.length === before, 'running 状态不上报')
}

// 会话结束
handlers.get('agent/disposed')({ agent })
assert(posted.some((p) => p.body.title === 'DSH 会话结束'), '会话结束已上报')

// beacon_send 工具
{
  const def = tools.get('beacon_send')
  assert(!!def, 'beacon_send 已注册')
  const ok = await def.execute({ text: '测试消息', level: 'critical' })
  assert(ok.sent === true && typeof ok.id === 'string', 'beacon_send 发送成功')
  const last = posted[posted.length - 1]
  assert(last.body.flash === true, 'critical 级别带 flash')
  const bad = await def.execute({ text: 'x', level: 'bogus' })
  assert(bad.sent === true, '非法级别回退 info 仍发送')
}

// 进程退出：effect 返回的清理函数上报停止事件
{
  const before = posted.length
  await effects[0]()()
  assert(posted.length === before + 1 && posted[posted.length - 1].body.title === 'dsh 进程已停止', '进程停止已上报')
}

// fetch 异常时静默
{
  globalThis.fetch = async () => { throw new Error('connection refused') }
  const def = tools.get('beacon_send')
  const res = await def.execute({ text: 'x' })
  assert(res.sent === false, 'beacon 不可达时静默失败并返回 sent=false')
}

// 环境变量回退：config 为空时读 BEACON_URL / BEACON_TOKEN
{
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body), headers: init.headers })
    return { ok: true, json: async () => ({ id: `evt-${posted.length}` }) }
  }
  process.env.BEACON_URL = 'http://env-beacon.test:9999'
  process.env.BEACON_TOKEN = 'env-tok'
  const ctx2 = {
    on() {}, tools: { register() {} }, effect() {}
  }
  plugin.apply(ctx2, {})
  delete process.env.BEACON_URL
  delete process.env.BEACON_TOKEN
  const last = posted[posted.length - 1]
  assert(last.url.startsWith('http://env-beacon.test:9999/'), 'url 回退到 BEACON_URL')
  assert(last.headers.Authorization === 'Bearer env-tok', 'token 回退到 BEACON_TOKEN')
}

globalThis.fetch = realFetch
console.log(process.exitCode ? '\n存在失败' : '\n全部通过')
