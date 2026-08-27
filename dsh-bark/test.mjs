// dsh-bark 核心逻辑测试：stub fetch 捕获推送请求，验证参数映射、强制 passive、url 解析、默认值回退与错误处理。
import * as plugin from './lib/index.js'

const posted = []
const realFetch = globalThis.fetch
function stubOk(code = 200, message = 'success') {
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body), headers: init.headers, signal: init.signal })
    return { ok: true, status: 200, json: async () => ({ code, message }) }
  }
}

const tools = new Map()
const ctx = { tools: { register(def) { tools.set(def.name, def) } } }
const exec = { signal: undefined }

const assert = (cond, msg) => { if (!cond) { console.error('✗ FAIL:', msg); process.exitCode = 1 } else console.log('✓', msg) }

// ---- 基本注册 ----
stubOk()
plugin.apply(ctx, {
  server: 'https://bark.test/',
  deviceKey: 'KEY_DEFAULT',
  defaultSound: 'minuet',
  defaultGroup: 'grp',
  defaultIcon: 'https://icon.test/a.png'
})
const push = tools.get('bark_push')
assert(!!push, 'bark_push 已注册')
assert(push.parameters.level === undefined && push.parameters.call === undefined, '工具不再暴露 level/call 参数')

// ---- 最小推送：只给 body，使用默认 deviceKey，强制 passive ----
{
  const r = await push.execute({ body: '你好' }, exec)
  assert(r.sent === true && r.code === 200, '最小推送成功')
  const last = posted[posted.length - 1]
  assert(last.url === 'https://bark.test/push', 'server 末尾斜杠被去除且拼接 /push')
  assert(last.body.device_key === 'KEY_DEFAULT', '使用默认 deviceKey')
  assert(last.body.body === '你好', 'body 正确')
  assert(last.body.level === 'passive', '强制 passive 级别')
  assert(last.body.sound === 'minuet' && last.body.group === 'grp', '默认 sound/group 生效')
  assert(last.body.icon === 'https://icon.test/a.png', '默认 icon 生效')
  assert(last.signal instanceof AbortSignal, 'fetch 收到 AbortSignal')
}

// ---- 完整参数映射 ----
{
  await push.execute({
    body: '正文', title: '标题', subtitle: '副标题', deviceKey: 'KEY_X',
    sound: 'alarm', group: 'g2', url: 'https://x.test',
    icon: 'https://i.test/b.png', badge: 3, copy: '复制我', autoCopy: true, isArchive: true
  }, exec)
  const b = posted[posted.length - 1].body
  assert(b.device_key === 'KEY_X', '参数 deviceKey 覆盖默认')
  assert(b.title === '标题' && b.subtitle === '副标题', 'title/subtitle 映射')
  assert(b.level === 'passive', 'level 始终为 passive')
  assert(b.sound === 'alarm' && b.group === 'g2', '参数 sound/group 覆盖默认')
  assert(b.url === 'https://x.test' && b.icon === 'https://i.test/b.png', 'url/icon 映射')
  assert(b.badge === 3, 'badge 映射')
  assert(b.copy === '复制我', 'copy 映射')
  assert(b.autoCopy === '1' && b.isArchive === '1', 'autoCopy/isArchive 转成字符串 "1"')
  assert(!('call' in b), 'call 不再写入')
}

// ---- 传入 level/call 被忽略，仍为 passive ----
{
  await push.execute({ body: 'x', level: 'critical', call: true }, exec)
  const b = posted[posted.length - 1].body
  assert(b.level === 'passive' && !('call' in b), 'level/call 参数被忽略，仍强制 passive')
}

// ---- copy/autoCopy/isArchive 为 false/空不发送 ----
{
  await push.execute({ body: 'x', copy: '', autoCopy: false, isArchive: false }, exec)
  const b = posted[posted.length - 1].body
  assert(!('copy' in b) && !('autoCopy' in b) && !('isArchive' in b), 'copy/autoCopy/isArchive 空值不写入')
}

// ---- 缺 body ----
{
  const r = await push.execute({ body: '   ' }, exec)
  assert(r.sent === false && r.code === null, '空 body 被拒绝')
}

// ---- 服务端返回非 200 code ----
{
  stubOk(400, 'device key invalid')
  const r = await push.execute({ body: 'x' }, exec)
  assert(r.sent === false && r.code === 400 && r.message === 'device key invalid', '服务端错误码回传，sent=false')
}

// ---- 网络异常静默 ----
{
  globalThis.fetch = async () => { throw new Error('connection refused') }
  const r = await push.execute({ body: 'x' }, exec)
  assert(r.sent === false && r.code === null && r.message.includes('connection refused'), '网络异常返回 sent=false 且带错误信息')
}

// ---- 缺 deviceKey（无默认、无环境变量）----
{
  stubOk()
  const tools2 = new Map()
  const ctx2 = { tools: { register(def) { tools2.set(def.name, def) } } }
  delete process.env.BARK_DEVICE_KEY
  delete process.env.BARK_URL
  plugin.apply(ctx2, {})
  const p2 = tools2.get('bark_push')
  const r = await p2.execute({ body: 'x' }, exec)
  assert(r.sent === false && r.message.includes('设备密钥'), '无 deviceKey 时明确报错')
}

// ---- url 配置解析 ----
{
  stubOk()
  const tools4 = new Map()
  const ctx4 = { tools: { register(def) { tools4.set(def.name, def) } } }
  plugin.apply(ctx4, { url: 'https://bark-url.test/KEY_FROM_URL' })
  const p4 = tools4.get('bark_push')
  await p4.execute({ body: 'x' }, exec)
  const last = posted[posted.length - 1]
  assert(last.url === 'https://bark-url.test/push', 'url 解析出 server')
  assert(last.body.device_key === 'KEY_FROM_URL', 'url 解析出 deviceKey')
}

// ---- 环境变量回退 ----
{
  stubOk()
  process.env.BARK_SERVER = 'https://env-bark.test'
  process.env.BARK_DEVICE_KEY = 'ENV_KEY'
  const tools3 = new Map()
  const ctx3 = { tools: { register(def) { tools3.set(def.name, def) } } }
  plugin.apply(ctx3, {})
  const p3 = tools3.get('bark_push')
  await p3.execute({ body: 'x' }, exec)
  const last = posted[posted.length - 1]
  assert(last.url === 'https://env-bark.test/push', 'server 回退到 BARK_SERVER')
  assert(last.body.device_key === 'ENV_KEY', 'deviceKey 回退到 BARK_DEVICE_KEY')
  delete process.env.BARK_SERVER
  delete process.env.BARK_DEVICE_KEY
}

// ---- BARK_URL 环境变量优先级最高 ----
{
  stubOk()
  process.env.BARK_URL = 'https://env-url.test/KEY_ENV_URL'
  const tools5 = new Map()
  const ctx5 = { tools: { register(def) { tools5.set(def.name, def) } } }
  plugin.apply(ctx5, { url: 'https://cfg-url.test/KEY_CFG', server: 'https://cfg.test', deviceKey: 'KEY_CFG2' })
  const p5 = tools5.get('bark_push')
  await p5.execute({ body: 'x' }, exec)
  const last = posted[posted.length - 1]
  assert(last.url === 'https://env-url.test/push' && last.body.device_key === 'KEY_ENV_URL', 'BARK_URL 环境变量覆盖配置 url')
  delete process.env.BARK_URL
}

// ---- 输出渲染为可读文本 ----
{
  const ok = PUSH_OK_RENDER()
  assert(ok.includes('✅ 已推送'), '成功渲染为可读文本')
}

function PUSH_OK_RENDER() {
  return push.output.render({}, { sent: true, code: 200, message: 'success' })[0].text
}

globalThis.fetch = realFetch
console.log(process.exitCode ? '\n存在失败' : '\n全部通过')
