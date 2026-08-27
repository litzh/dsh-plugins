import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'bark'
const inject = ['tools']

const Config = z.object({
  /** Bark 服务地址（末尾斜杠会被自动去除）。缺省读环境变量 BARK_SERVER。 */
  server: z.string().default('https://api.day.app'),
  /** 默认设备密钥（device key）。工具参数 deviceKey 可覆盖。缺省读环境变量 BARK_DEVICE_KEY。 */
  deviceKey: z.string().default(''),
  /** 默认铃声。 */
  defaultSound: z.string().default(''),
  /** 默认分组。 */
  defaultGroup: z.string().default(''),
  /** 默认图标 URL（仅 iOS 15+）。 */
  defaultIcon: z.string().default('')
}).default({})

const TIMEOUT_MS = 10000

const PUSH_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sent: { type: 'boolean', required: true },
      code: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
      message: { type: 'string', required: true }
    }
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
}

const LEVELS = ['critical', 'active', 'timeSensitive', 'passive']

function apply(ctx, config = {}) {
  const server = (config.server || process.env.BARK_SERVER || 'https://api.day.app').replace(/\/+$/, '')
  const defaultKey = config.deviceKey || process.env.BARK_DEVICE_KEY || ''
  const defaultSound = config.defaultSound || ''
  const defaultGroup = config.defaultGroup || ''
  const defaultIcon = config.defaultIcon || ''

  /** 调用 Bark /push；失败返回结构化错误而不抛异常。 */
  async function push(payload) {
    try {
      const res = await fetch(`${server}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        /* 非 JSON 响应 */
      }
      if (data && typeof data.code === 'number') {
        return { sent: data.code === 200, code: data.code, message: String(data.message ?? '') }
      }
      return { sent: res.ok, code: res.status, message: res.ok ? 'ok' : `HTTP ${res.status}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { sent: false, code: null, message }
    }
  }

  ctx.tools.register(defineTool({
    name: 'bark_push',
    description:
      '通过 Bark 向 iOS 设备推送一条通知。至少提供 body（正文）。' +
      '设备密钥优先用参数 deviceKey，否则用插件配置/环境变量中的默认密钥。' +
      '返回是否发送成功及服务端返回码。',
    parameters: {
      body: { type: 'string', required: true, description: '通知正文内容。' },
      title: { type: 'string', description: '通知标题（字号大于正文）。' },
      subtitle: { type: 'string', description: '通知副标题。' },
      deviceKey: { type: 'string', description: '目标设备密钥；不填则用默认配置。' },
      level: {
        type: 'string',
        description: '通知级别：critical | active | timeSensitive | passive。'
      },
      sound: { type: 'string', description: '铃声名称；不填用默认铃声。' },
      group: { type: 'string', description: '通知分组；不填用默认分组。' },
      url: { type: 'string', description: '点击通知跳转的 URL。' },
      icon: { type: 'string', description: '通知图标 URL（仅 iOS 15+）；不填用默认图标。' },
      badge: { type: 'number', description: 'App 图标角标数字。' },
      call: { type: 'boolean', description: '为 true 时持续响铃 30 秒。' },
      isArchive: { type: 'boolean', description: '为 true 时让 App 存档该通知。' }
    },
    output: PUSH_OUTPUT,
    timeoutMs: 15000,
    async execute(args) {
      const deviceKey = (args.deviceKey || defaultKey || '').trim()
      if (!deviceKey) {
        return { sent: false, code: null, message: '缺少设备密钥：请在参数 deviceKey 或插件配置/环境变量 BARK_DEVICE_KEY 中提供' }
      }
      if (!args.body || !String(args.body).trim()) {
        return { sent: false, code: null, message: '缺少 body（通知正文）' }
      }

      const payload = { device_key: deviceKey, body: String(args.body) }
      if (args.title) payload.title = String(args.title)
      if (args.subtitle) payload.subtitle = String(args.subtitle)
      if (args.level && LEVELS.includes(args.level)) payload.level = args.level
      const sound = args.sound || defaultSound
      if (sound) payload.sound = sound
      const group = args.group || defaultGroup
      if (group) payload.group = group
      const icon = args.icon || defaultIcon
      if (icon) payload.icon = icon
      if (args.url) payload.url = String(args.url)
      if (typeof args.badge === 'number') payload.badge = args.badge
      if (args.call === true) payload.call = '1'
      if (args.isArchive === true) payload.isArchive = '1'

      return push(payload)
    }
  }))
}

export { Config, apply, inject, name }
