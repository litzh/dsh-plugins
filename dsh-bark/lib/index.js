import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'dsh-bark'
const inject = ['tools']

const Config = z.object({
  /** 完整 Bark 推送地址（https://api.day.app/<key>），自动解析 server + deviceKey。缺省读环境变量 BARK_URL。 */
  url: z.string().default(''),
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
  render: (_args, value) => [{
    type: 'text',
    text: value.sent
      ? `✅ 已推送：${value.message || 'ok'}`
      : value.code != null
        ? `❌ 推送失败（HTTP ${value.code}）：${value.message}`
        : `❌ 推送失败：${value.message}`
  }]
}

/** 从 "https://api.day.app/<key>" 形式的 URL 解析 server 与 deviceKey。 */
function parseBarkUrl(url) {
  const u = new URL(url)
  const key = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? ''
  return { server: u.origin, deviceKey: key }
}

function apply(ctx, config = {}) {
  // 解析 server/deviceKey：环境变量 > url（含 BARK_URL）> server/deviceKey
  let server = config.server || ''
  let deviceKey = config.deviceKey || ''
  const url = process.env.BARK_URL || config.url || ''
  if (url) {
    const parsed = parseBarkUrl(url)
    server = parsed.server
    deviceKey = parsed.deviceKey
  }
  if (process.env.BARK_SERVER) server = process.env.BARK_SERVER
  if (process.env.BARK_DEVICE_KEY) deviceKey = process.env.BARK_DEVICE_KEY
  server = (server || 'https://api.day.app').replace(/\/+$/, '')
  const defaultKey = deviceKey || ''
  const defaultSound = config.defaultSound || ''
  const defaultGroup = config.defaultGroup || ''
  const defaultIcon = config.defaultIcon || ''

  /** 调用 Bark /push；失败返回结构化错误而不抛异常。signal 用于在工具被取消时中止请求。 */
  async function push(payload, signal) {
    try {
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const merged =
        signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([timeout, signal])
          : timeout
      const res = await fetch(`${server}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: merged
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
      '通过 Bark 向 iOS 设备推送一条静默（passive）通知，不会响铃或震动。至少提供 body（正文）。' +
      '设备密钥优先用参数 deviceKey，否则用插件配置/环境变量中的默认密钥。' +
      '该工具固定为 passive 静默级别，无法发送 critical/timeSensitive 或强响铃（call）推送。' +
      '返回是否发送成功及服务端返回码。',
    parameters: {
      body: { type: 'string', required: true, description: '通知正文内容。' },
      title: { type: 'string', description: '通知标题（字号大于正文）。' },
      subtitle: { type: 'string', description: '通知副标题。' },
      deviceKey: { type: 'string', description: '目标设备密钥；不填则用默认配置。' },
      sound: { type: 'string', description: '铃声名称；不填用默认铃声（传 none 可静音）。' },
      group: { type: 'string', description: '通知分组；不填用默认分组。' },
      url: { type: 'string', description: '点击通知跳转的 URL。' },
      icon: { type: 'string', description: '通知图标 URL（仅 iOS 15+）；不填用默认图标。' },
      badge: { type: 'number', description: 'App 图标角标数字。' },
      copy: { type: 'string', description: '推送时自动复制到剪贴板的内容。' },
      autoCopy: { type: 'boolean', description: '为 true 时自动复制通知正文到剪贴板。' },
      isArchive: { type: 'boolean', description: '为 true 时让 App 存档该通知。' }
    },
    output: PUSH_OUTPUT,
    timeoutMs: 15000,
    presentCall: (args) => ({
      card: 'generic',
      title: 'bark_push',
      kind: 'other',
      rawInput: String(args.body ?? ''),
      content: [{
        type: 'text',
        text: args.title ? `推送「${args.title}」到 iOS 设备` : '推送通知到 iOS 设备'
      }]
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'bark_push 失败' : 'bark_push',
      content: result.content
    }),
    async execute(args, exec) {
      const key = (args.deviceKey || defaultKey || '').trim()
      if (!key) {
        return { sent: false, code: null, message: '缺少设备密钥：请在参数 deviceKey 或插件配置/环境变量（BARK_DEVICE_KEY / BARK_URL）中提供' }
      }
      if (!args.body || !String(args.body).trim()) {
        return { sent: false, code: null, message: '缺少 body（通知正文）' }
      }

      const payload = { device_key: key, body: String(args.body), level: 'passive' }
      if (args.title) payload.title = String(args.title)
      if (args.subtitle) payload.subtitle = String(args.subtitle)
      const sound = args.sound || defaultSound
      if (sound) payload.sound = sound
      const group = args.group || defaultGroup
      if (group) payload.group = group
      const icon = args.icon || defaultIcon
      if (icon) payload.icon = icon
      if (args.url) payload.url = String(args.url)
      if (typeof args.badge === 'number') payload.badge = args.badge
      if (args.copy) payload.copy = String(args.copy)
      if (args.autoCopy === true) payload.autoCopy = '1'
      if (args.isArchive === true) payload.isArchive = '1'

      return push(payload, exec?.signal)
    }
  }))
}

export { Config, apply, inject, name }
