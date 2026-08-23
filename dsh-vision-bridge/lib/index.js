/**
 * dsh-vision-bridge：让纯文本模型调用视觉模型识别图片。
 *
 * 主对话模型（不支持多模态）调用 describe_image 工具；插件读取图片文件、
 * 通过 ctx.attachments 持久化为规范化的图片附件，然后用配置的视觉路由
 * 发起一次独立的辅助 LLM 调用（ctx.llm.stream），把视觉模型的文字描述
 * 作为工具结果返回。图片字节只进入视觉模型的请求，从不进入主模型上下文。
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_QUESTION,
  DEFAULT_SYSTEM_PROMPT,
  finishError,
  imageMediaTypeForPath,
  resolveQuestion
} from './vision-utils.js'

const name = 'vision-bridge'
const inject = ['tools', 'llm', 'attachments']

const Config = z.object({
  /** 视觉模型的 provider 路由（必须在 dsh 中已注册，且模型 inputModalities 含 image）。 */
  provider: z.string(),
  /** 视觉模型 id。 */
  model: z.string(),
  /** 视觉调用的最大输出 token 数。 */
  maxTokens: z.number().default(4096),
  /** 单次视觉调用的超时秒数。 */
  timeoutSeconds: z.number().default(120),
  /** 视觉模型的系统指令。 */
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT)
})

const DESCRIBE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      description: { type: 'string', required: true },
      mediaType: { type: 'string', required: true },
      width: { type: 'integer', required: true },
      height: { type: 'integer', required: true },
      bytes: { type: 'integer', required: true }
    }
  },
  render: (_args, value) => [{
    type: 'text',
    text: `Image: ${value.mediaType}, ${value.width}x${value.height}px, ${value.bytes} bytes.\n\n${value.description}`
  }]
}

function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'describe_image',
    description:
      'Recognize and describe an image file by delegating to a vision-capable model. '
      + 'Use this whenever you need to inspect image content (screenshots, diagrams, photos, '
      + 'scanned text) but cannot view the image yourself. Returns a textual description; '
      + 'the image itself never enters your context.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Absolute path of the image file (png/jpeg/webp/gif).'
      },
      question: {
        type: 'string',
        description: `What to ask about the image. Defaults to: "${DEFAULT_QUESTION}"`
      }
    },
    output: DESCRIBE_OUTPUT,
    presentCall: (args) => ({
      card: 'generic',
      title: 'describe_image',
      kind: 'read',
      locations: [{ path: args.file_path }]
    }),
    async execute(args, exec) {
      const mediaType = imageMediaTypeForPath(args.file_path)
      if (mediaType === undefined) {
        throw new Error(`describe_image: unsupported image extension in "${args.file_path}"; expected png/jpeg/webp/gif`)
      }
      const data = await readFile(args.file_path, { signal: exec.signal })
      const ref = await ctx.attachments.saveImage({
        data: new Uint8Array(data),
        mediaType,
        name: basename(args.file_path)
      })

      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutSeconds * 1000)])
      const message = createUserMessage({
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: resolveQuestion(args.question) }
        ],
        source: { kind: 'plugin', plugin: name }
      })
      const options = {
        provider: config.provider,
        model: config.model,
        messages: [message],
        system: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        maxTokens: config.maxTokens ?? 4096,
        signal,
        ...exec.agent === undefined ? {} : { sessionId: exec.agent.id }
      }

      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream(options)) {
        signal.throwIfAborted()
        assembler.push(chunk)
      }
      const terminalError = finishError(assembler.finish)
      if (terminalError !== undefined) throw terminalError
      const text = assembler.blocks()
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text.length === 0) throw new Error('vision-bridge: vision model produced no text')
      return {
        description: text,
        mediaType: ref.mediaType,
        width: ref.width,
        height: ref.height,
        bytes: ref.bytes
      }
    }
  }))
}

export { Config, apply, inject, name }
