// dsh-vision-bridge 纯逻辑测试：扩展名映射、question 默认值、finish 终态转换。
// 只导入无外部依赖的 lib/vision-utils.js，可在任何 Node 环境直接运行。
import {
  DEFAULT_QUESTION,
  finishError,
  imageMediaTypeForPath,
  resolveQuestion
} from './lib/vision-utils.js'

const assert = (cond, msg) => { if (!cond) { console.error('✗ FAIL:', msg); process.exitCode = 1 } else console.log('✓', msg) }

// 扩展名映射
assert(imageMediaTypeForPath('/tmp/a.png') === 'image/png', 'png 扩展名')
assert(imageMediaTypeForPath('/tmp/a.JPG') === 'image/jpeg', 'JPG 大小写不敏感')
assert(imageMediaTypeForPath('/tmp/a.jpeg') === 'image/jpeg', 'jpeg 扩展名')
assert(imageMediaTypeForPath('/tmp/a.webp') === 'image/webp', 'webp 扩展名')
assert(imageMediaTypeForPath('/tmp/a.gif') === 'image/gif', 'gif 扩展名')
assert(imageMediaTypeForPath('/tmp/a.txt') === undefined, '非图片扩展名拒绝')
assert(imageMediaTypeForPath('/tmp/noext') === undefined, '无扩展名拒绝')

// question 默认值
assert(resolveQuestion('图里有什么？') === '图里有什么？', '保留模型给出的 question')
assert(resolveQuestion('   ') === DEFAULT_QUESTION, '空白 question 回退默认')
assert(resolveQuestion(undefined) === DEFAULT_QUESTION, '缺省 question 回退默认')

// finish 终态
assert(finishError({ kind: 'stop' }) === undefined, 'stop 不是错误')
assert(finishError(undefined)?.message.includes('without a finish reason'), '缺 finish 报错')
assert(finishError({ kind: 'error', failure: { message: 'boom' } })?.message.includes('boom'), 'error 透传失败信息')
assert(finishError({ kind: 'aborted', failure: { message: 'cancelled' } })?.message.includes('cancelled'), 'aborted 透传失败信息')
assert(finishError({ kind: 'max-tokens' })?.message.includes('maxTokens'), 'max-tokens 提示调大配置')
assert(finishError({ kind: 'tool-calls' })?.message.includes('tool'), 'tool-calls 报错')
assert(finishError({ kind: 'other' })?.message.includes('other'), '未知终态报错')

console.log('done')
