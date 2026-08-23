/**
 * Standalone smoke test: boots the plugin against a fake cordis context and a
 * fake ApiProxy, then drives the MCP endpoint over real HTTP.
 * Run: node test/smoke.mjs
 */
import { apply } from '../index.js'

const fakeApiProxy = {
  sessions: {
    async list() {
      return { rpcId: 'x', result: { ok: true, value: { items: [{ sessionId: 'session-fake', running: true, updatedAt: Date.now(), projections: { values: { title: 'fake session' } } }] } } }
    },
    async create() {
      return { rpcId: 'x', result: { ok: true, value: { sessionId: 'session-new' } } }
    },
    async prompt({ payload }) {
      return { rpcId: 'x', result: { ok: true, value: { accepted: true, echoed: payload.content[0].text } } }
    },
    async history() {
      return { rpcId: 'x', result: { ok: true, value: { hasMore: false, events: [
        { event: { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } } },
        { event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'hello back' }] } } } },
        { event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } } },
      ] } } }
    },
    async cancel() {
      return { rpcId: 'x', result: { ok: true, value: { accepted: true } } }
    },
  },
}

const disposers = []
const fakeCtx = {
  effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
  get(name) { return name === 'apiProxy' ? fakeApiProxy : undefined },
  on() { return () => {} },
  logger: console,
  inject(deps, callback) {
    // Fake: every requested service resolves immediately from the fake map.
    const scope = { apiProxy: fakeApiProxy }
    if (deps.every(dep => dep === 'apiProxy')) callback(scope)
  },
}

const port = 3099
apply(fakeCtx, { port })
await new Promise(resolve => setTimeout(resolve, 300))

async function mcp(body) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  // Streamable HTTP may answer as SSE; take the last data: payload.
  const dataLine = text.split('\n').filter(line => line.startsWith('data:')).pop()
  return JSON.parse(dataLine ? dataLine.slice(5) : text)
}

const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
console.log('initialize:', init.result?.serverInfo ?? init.error)

const tools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
console.log('tools:', tools.result?.tools?.map(tool => tool.name) ?? tools.error)

const list = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsh_session_list', arguments: {} } })
console.log('dsh_session_list:', list.result?.content?.[0]?.text ?? list.error)

const prompt = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_prompt', arguments: { text: 'ping' } } })
console.log('dsh_prompt:', prompt.result?.content?.[0]?.text ?? prompt.error)

const history = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'dsh_history', arguments: { sessionId: 'session-fake' } } })
console.log('dsh_history:', history.result?.content?.[0]?.text ?? history.error)

for (const dispose of disposers) await dispose()
console.log('SMOKE OK')
process.exit(0)
