import fs from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'image-router'
const inject = ['llm', 'attachments', 'tools']

const Config = z.object({
  /** 总开关：用户输入含图片且当前模型不支持图片时，是否自动路由识别。 */
  enabled: z.boolean().default(true),
  /** 识图模型的 provider 路由（settings.yaml 中配置的自定义供应商，本地或远程均可）。 */
  provider: z.string().default('deepseek-official'),
  /** 识图模型 id。 */
  model: z.string().default('deepseek-v4-flash'),
  /** 识图输出最大 token 数。 */
  maxTokens: z.number().default(4096),
  /** 会话尚无 request header、模型能力未知时的策略：pass 放行（默认）/ route 路由识别。 */
  unknownCapability: z.string().default('pass')
}).default({})

const RECOGNIZE_PROMPT = '请详细识别并描述这张/这些图片的全部内容。若包含文字、代码、命令、表格、报错信息或 UI 界面，请尽可能完整、准确地转录出来（保留原始格式）。只输出识别结果，不要调用任何工具。'

const EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

const DESCRIBE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      description: { type: 'string', required: true },
      images: { type: 'array', items: { type: 'string' }, required: true },
      skipped: { type: 'array', items: { type: 'string' }, required: true }
    }
  },
  render: (_args, value) => [{ type: 'text', text: value.description }]
}

function buildPrompt(userText) {
  const trimmed = (userText ?? '').trim()
  return trimmed ? `${RECOGNIZE_PROMPT}\n\n用户针对图片的问题是：${trimmed}` : RECOGNIZE_PROMPT
}

function hasImage(content) {
  return Array.isArray(content) && content.some((block) => block?.type === 'image')
}

/** 一次性调用识图模型，汇总 text-delta 为完整文本。 */
async function recognize(ctx, config, imageBlocks, userText, signal) {
  const message = createUserMessage({
    source: { kind: 'plugin', plugin: name },
    content: [{ type: 'text', text: buildPrompt(userText) }, ...imageBlocks]
  })
  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider: config.provider,
    model: config.model,
    messages: [message],
    maxTokens: config.maxTokens,
    signal
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  const trimmed = text.trim()
  if (!trimmed) throw new Error('识图模型返回了空内容')
  return trimmed
}

function apply(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled ?? true,
    provider: config.provider ?? 'deepseek-official',
    model: config.model ?? 'deepseek-v4-flash',
    maxTokens: config.maxTokens ?? 4096,
    unknownCapability: config.unknownCapability ?? 'pass'
  }
  const modelLabel = `${cfg.provider}/${cfg.model}`

  /** 模型图片能力缓存：true / false / undefined（未知）。 */
  const capabilityCache = new Map()

  /** 判定指定 provider/model 是否支持图片输入；能力未知返回 undefined。 */
  async function modelSupportsImage(provider, model) {
    const key = `${provider}/${model}`
    if (capabilityCache.has(key)) return capabilityCache.get(key)
    let result
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const mods = info?.inputModalities
      result = Array.isArray(mods) ? mods.includes('image') : undefined
    } catch {
      result = undefined
    }
    capabilityCache.set(key, result)
    return result
  }

  /** 当前会话使用的 provider/model；无法确定时返回 undefined。 */
  function currentRoute(agent) {
    if (agent.options?.provider && agent.options?.model) {
      return { provider: agent.options.provider, model: agent.options.model }
    }
    const logged = agent.session?.requestHeader?.()?.config
    if (logged?.provider && logged?.model) return { provider: logged.provider, model: logged.model }
    return undefined
  }

  /** 当前 agent 的模型是否支持图片；能力未知时按 unknownCapability 策略解释。 */
  async function shouldRoute(agent) {
    const route = currentRoute(agent)
    const supports = route ? await modelSupportsImage(route.provider, route.model) : undefined
    if (supports === true) return false
    if (supports === false) return true
    return cfg.unknownCapability === 'route'
  }

  // —— 自动路由：替换进入 step 的消息（durable log 中原图保留）—— //
  ctx.on('agent/pre-step', async (payload, next) => {
    if (!cfg.enabled) return next()
    const images = payload.messages.filter((message) => hasImage(message.content))
    if (images.length === 0) return next()
    if (!(await shouldRoute(payload.agent))) return next()

    try {
      const userText = payload.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')

      const replaced = []
      for (const message of payload.messages) {
        if (!hasImage(message.content)) {
          replaced.push(message)
          continue
        }
        const imageBlocks = message.content.filter((block) => block.type === 'image')
        const desc = await recognize(ctx, cfg, imageBlocks, userText, payload.signal)
        const header = `[图片识别结果 · 由 ${modelLabel} 生成，共 ${imageBlocks.length} 张]`
        const content = []
        for (const block of message.content) {
          if (block.type === 'image') continue
          content.push(block)
        }
        content.push({ type: 'text', text: `${header}\n${desc}` })
        replaced.push({ ...message, content })
      }
      return { kind: 'enter', messages: replaced }
    } catch (error) {
      // 识别失败则原样放行（适配器可能对图片报 UNSUPPORTED_CONTENT，但不阻塞流程）
      ctx.logger?.warn?.(`image-router: 图片识别失败，原样放行: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
  })

  // —— 识图工具：模型运行中主动识别本地图片文件 —— //
  ctx.tools.register(defineTool({
    name: 'image_describe',
    description: '识别本地图片文件的内容，返回文字描述/转录结果。仅供不支持图片输入的模型使用（支持图片输入的模型应直接用 read 工具查看图片）。由配置的多模态模型完成识别（可为自定义供应商的本地模型）。',
    parameters: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '要识别的图片文件路径列表（绝对路径），可多张。'
      },
      prompt: {
        type: 'string',
        description: '想从图片中了解什么，例如「转录其中的报错信息」。留空则完整识别并描述图片全部内容。'
      }
    },
    output: DESCRIBE_OUTPUT,
    timeoutMs: 180000,
    async execute(args, exec) {
      // 软守卫：当前模型本身支持图片时提示改用 read（正常此时不该调用本工具，兜底防误用）
      if (exec.agent && !(await shouldRoute(exec.agent))) {
        throw new Error('当前模型已支持图片输入，请改用内置 read 工具直接读取这些图片文件（read 支持 png/jpg/gif/webp/bmp），无需使用 image_describe。')
      }

      const valid = []
      const invalid = []
      for (const p of args.paths) {
        const mime = EXT_TO_MIME[path.extname(p).toLowerCase()]
        if (mime && fs.existsSync(p)) valid.push({ path: p, mime })
        else invalid.push(p)
      }
      if (valid.length === 0) {
        throw new Error(`没有可用的图片文件。以下路径不存在或不是图片（png/jpg/gif/webp/bmp）：\n${invalid.join('\n')}`)
      }

      const imageBlocks = []
      for (const { path: p, mime } of valid) {
        const ref = await ctx.attachments.saveImage({
          data: new Uint8Array(fs.readFileSync(p)),
          mediaType: mime,
          name: path.basename(p)
        })
        imageBlocks.push({ type: 'image', attachment: ref })
      }

      const desc = await recognize(ctx, cfg, imageBlocks, args.prompt, exec.signal)
      const note = invalid.length > 0 ? `\n\n（已跳过无效路径：${invalid.join('、')}）` : ''
      return {
        description: desc + note,
        images: valid.map((v) => v.path),
        skipped: invalid
      }
    }
  }))
}

export { Config, apply, inject, name }
