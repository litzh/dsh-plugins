/** dsh-vision-bridge 的纯逻辑（无外部依赖，可被 test.mjs 直接导入测试）。 */

/** describe_image 接受的扩展名；图片字节的权威校验在 attachment 服务完成。 */
export const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are the vision backend of a coding assistant whose primary model cannot see images.',
  'Answer the question about the image accurately and concretely.',
  'Transcribe any text, code, or error messages in the image verbatim when relevant.',
  'Use the language of the question.'
].join('\n')

export const DEFAULT_QUESTION = 'Describe this image in detail. Transcribe any text it contains.'

/** 按扩展名判定声明的 media type；不支持的扩展名返回 undefined。 */
export function imageMediaTypeForPath(filePath) {
  const name = String(filePath ?? '')
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  return IMAGE_EXTENSIONS[name.slice(dot).toLowerCase()]
}

/** 模型未给 question 或只给了空白时使用默认提问。 */
export function resolveQuestion(question) {
  return typeof question === 'string' && question.trim().length > 0 ? question : DEFAULT_QUESTION
}

/** 把视觉调用的终态转换为工具错误；正常 stop 返回 undefined。 */
export function finishError(finish) {
  if (finish === undefined || finish === null) {
    return new Error('vision-bridge: vision model stream ended without a finish reason')
  }
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted':
      return new Error(`vision-bridge: vision call ${finish.kind}: ${finish.failure.message}`)
    case 'max-tokens':
      return new Error('vision-bridge: vision model output reached maxTokens; increase maxTokens in the plugin config')
    case 'tool-calls':
      return new Error('vision-bridge: vision model unexpectedly requested a tool')
    default:
      return new Error(`vision-bridge: unsupported finish reason "${String(finish.kind)}"`)
  }
}
