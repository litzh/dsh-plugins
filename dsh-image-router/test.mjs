// dsh-image-router 核心逻辑测试：mock llm / attachments / tools，
// 验证 pre-step 图片路由、能力判定缓存、unknown 策略与 image_describe 工具。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from './lib/index.js'

const assert = (cond, msg) => { if (!cond) { console.error('✗ FAIL:', msg); process.exitCode = 1 } else console.log('✓', msg) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-router-test-'))
const imgPath = path.join(tmp, 'shot.png')
fs.writeFileSync(imgPath, Buffer.from('fake-png-bytes'))

const IMG_REF = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 14, width: 10, height: 10 }
const imageBlock = { type: 'image', attachment: IMG_REF }
const userMessage = (content) => ({ id: 'm1', role: 'user', source: { kind: 'user' }, content })

/** 构造 mock ctx。modalities: { 'prov/model': ['text','image'] | ['text'] | undefined } */
function makeCtx({ modalities = {}, recognizeText = '识别结果：一张截图', recognizeThrows = false } = {}) {
  const handlers = new Map()
  const tools = new Map()
  const llmCalls = []
  const savedImages = []
  const warnings = []
  const ctx = {
    on(event, fn) { handlers.set(event, fn) },
    tools: { register(def) { tools.set(def.name, def) } },
    logger: { warn: (m) => warnings.push(m) },
    llm: {
      async resolveModelInfo(provider, model) {
        const mods = modalities[`${provider}/${model}`]
        return mods === undefined ? { provider, id: model, name: model } : { provider, id: model, name: model, inputModalities: mods }
      },
      async *stream(options) {
        llmCalls.push(options)
        if (recognizeThrows) throw new Error('模型服务不可用')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: recognizeText.slice(0, 4) }
        yield { type: 'text-delta', index: 0, text: recognizeText.slice(4) }
      }
    },
    attachments: {
      async saveImage(input) { savedImages.push(input); return { ...IMG_REF, attachmentId: `att-${savedImages.length}` } }
    },
    _handlers: handlers, _tools: tools, _llmCalls: llmCalls, _savedImages: savedImages, _warnings: warnings
  }
  return ctx
}

function agentWithRoute(provider, model) {
  return {
    options: {},
    session: { requestHeader: () => ({ config: { provider, model } }) }
  }
}

const nextPass = (messages) => async () => ({ kind: 'enter', messages })

// --- 1. 模型支持图片：放行，不调识图 ---
{
  const ctx = makeCtx({ modalities: { 'main/text-img': ['text', 'image'] } })
  plugin.apply(ctx, { provider: 'test-vlm', model: 'vlm' })
  const messages = [userMessage([{ type: 'text', text: '看图' }, imageBlock])]
  const result = await ctx._handlers.get('agent/pre-step')(
    { agent: agentWithRoute('main', 'text-img'), messages, signal: undefined }, nextPass(messages))
  assert(result.messages === messages, '支持图片的模型：消息原样放行')
  assert(ctx._llmCalls.length === 0, '支持图片的模型：未调用识图模型')
}

// --- 2. 模型不支持图片：替换消息 ---
{
  const ctx = makeCtx({ modalities: { 'main/text-only': ['text'] } })
  plugin.apply(ctx, { provider: 'test-vlm', model: 'vlm' })
  const original = userMessage([{ type: 'text', text: '这个报错什么意思' }, imageBlock])
  const result = await ctx._handlers.get('agent/pre-step')(
    { agent: agentWithRoute('main', 'text-only'), messages: [original], signal: undefined }, nextPass([original]))
  const replaced = result.messages[0]
  assert(replaced !== original, '不支持图片的模型：返回替换后的新消息')
  assert(!replaced.content.some((b) => b.type === 'image'), '替换后消息不含图片块')
  assert(replaced.content.some((b) => b.type === 'text' && b.text.includes('识别结果：一张截图')), '替换后消息含识别文本')
  assert(replaced.content.some((b) => b.type === 'text' && b.text.includes('这个报错什么意思')), '原文字保留')
  assert(original.content.some((b) => b.type === 'image'), '原消息（durable log）图片未被修改')
  assert(ctx._llmCalls.length === 1, '调用了一次识图模型')
  const call = ctx._llmCalls[0]
  assert(call.provider === 'test-vlm' && call.model === 'vlm', '识图使用配置的 provider/model')
  assert(call.messages[0].content.some((b) => b.type === 'image'), '识图请求携带图片块')
  assert(call.messages[0].content[0].text.includes('这个报错什么意思'), '识图提示词带用户问题')
}

// --- 3. 无图片消息：直接放行 ---
{
  const ctx = makeCtx()
  plugin.apply(ctx, {})
  const messages = [userMessage([{ type: 'text', text: '纯文本' }])]
  const result = await ctx._handlers.get('agent/pre-step')(
    { agent: agentWithRoute('main', 'x'), messages, signal: undefined }, nextPass(messages))
  assert(result.messages === messages, '无图片消息直接放行')
}

// --- 4. 能力未知策略 ---
{
  const ctx = makeCtx({ modalities: {} }) // resolveModelInfo 无 inputModalities → 未知
  plugin.apply(ctx, { provider: 'test-vlm', model: 'vlm', unknownCapability: 'pass' })
  const messages = [userMessage([imageBlock])]
  const result = await ctx._handlers.get('agent/pre-step')(
    { agent: agentWithRoute('main', 'unknown-model'), messages, signal: undefined }, nextPass(messages))
  assert(result.messages === messages, '能力未知 + pass：放行')
}
{
  const ctx = makeCtx({ modalities: {} })
  plugin.apply(ctx, { provider: 'test-vlm', model: 'vlm', unknownCapability: 'route' })
  const messages = [userMessage([imageBlock])]
  const result = await ctx._handlers.get('agent/pre-step')(
    { agent: agentWithRoute('main', 'unknown-model'), messages, signal: undefined }, nextPass(messages))
  assert(result.messages !== messages, '能力未知 + route：路由识别')
}

// --- 5. 识别失败：原样放行 + 告警 ---
{
  const ctx = makeCtx({ modalities: { 'main/text-only': ['text'] }, recognizeThrows: true })
  plugin.apply(ctx, { provider: 'test-vlm', model: 'vlm' })
  const messages = [userMessage([imageBlock])]
  const result = await ctx._handlers.get('agent/pre-step')(
    { agent: agentWithRoute('main', 'text-only'), messages, signal: undefined }, nextPass(messages))
  assert(result.messages === messages, '识别失败原样放行')
  assert(ctx._warnings.some((w) => w.includes('图片识别失败')), '识别失败输出告警')
}

// --- 6. enabled=false 完全关闭 ---
{
  const ctx = makeCtx({ modalities: { 'main/text-only': ['text'] } })
  plugin.apply(ctx, { enabled: false })
  const messages = [userMessage([imageBlock])]
  const result = await ctx._handlers.get('agent/pre-step')(
    { agent: agentWithRoute('main', 'text-only'), messages, signal: undefined }, nextPass(messages))
  assert(result.messages === messages && ctx._llmCalls.length === 0, 'enabled=false 时不路由')
}

// --- 7. image_describe 工具 ---
{
  const ctx = makeCtx({ modalities: { 'main/text-only': ['text'] } })
  plugin.apply(ctx, { provider: 'test-vlm', model: 'vlm' })
  const def = ctx._tools.get('image_describe')
  assert(!!def, 'image_describe 已注册')
  const agent = agentWithRoute('main', 'text-only')
  const result = await def.execute({ paths: [imgPath, '/nonexistent/x.png'], prompt: '转录报错' }, { signal: undefined, agent })
  assert(result.description.includes('识别结果：一张截图'), '工具返回识别文本')
  assert(result.description.includes('已跳过无效路径'), '工具标注跳过的无效路径')
  assert(result.images.length === 1 && result.skipped.length === 1, '工具返回有效/无效路径清单')
  assert(ctx._savedImages.length === 1 && ctx._savedImages[0].mediaType === 'image/png', '图片经附件服务入库')
  assert(ctx._llmCalls[0].messages[0].content[0].text.includes('转录报错'), '工具提示词带用户提问')
}

// --- 8. image_describe 软守卫：模型支持图片时报错引导 read ---
{
  const ctx = makeCtx({ modalities: { 'main/vision': ['text', 'image'] } })
  plugin.apply(ctx, {})
  const def = ctx._tools.get('image_describe')
  let threw = false
  try {
    await def.execute({ paths: [imgPath] }, { signal: undefined, agent: agentWithRoute('main', 'vision') })
  } catch (e) {
    threw = e.message.includes('read')
  }
  assert(threw, '模型支持图片时软守卫引导改用 read')
}

// --- 9. image_describe 全部路径无效 ---
{
  const ctx = makeCtx()
  plugin.apply(ctx, {})
  const def = ctx._tools.get('image_describe')
  let threw = false
  try { await def.execute({ paths: ['/nope/a.txt'] }, { signal: undefined }) } catch { threw = true }
  assert(threw, '无有效图片路径时报错')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(process.exitCode ? '\n存在失败' : '\n全部通过')
