/**
 * Standalone smoke test: boots the plugin against a fake cordis context and a
 * fake ApiProxy, then drives the MCP endpoint over real HTTP.
 *
 * Fake event data uses the REAL session event shapes (packages/core/session):
 * user/message data is the message itself; assistant/message and tool/result
 * wrap theirs under `message`.
 *
 * Run: node test/smoke.mjs
 */
import { apply } from '../index.js'

const fakeEvents = [
  { event: { type: 'user/message', seq: 1, data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } } },
  { event: { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'let me check' }, { type: 'toolCall', name: 'bash' }] } } } },
  { event: { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } } },
  { event: { type: 'tool/result', seq: 4, data: { turn: 1, step: 1, message: { role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'file.txt' }] }] } } } },
  { event: { type: 'assistant/message', seq: 5, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] } } } },
  { event: { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } } },
]

const calls = []
const fakeApiProxy = {
  sessions: {
    async list() {
      return { rpcId: 'x', result: { ok: true, value: { items: [
        { sessionId: 'session-fake', running: true, cwd: '/tmp/a', updatedAt: Date.now(), projections: { values: { title: 'fake session' } } },
        { sessionId: 'session-idle', running: false, cwd: '/tmp/b', updatedAt: Date.now(), projections: { values: { title: 'idle session' } } },
      ] } } }
    },
    async search(request, signal) {
      calls.push(['search', request.payload, signal instanceof AbortSignal])
      return { rpcId: 'x', result: { ok: true, value: { items: [{ sessionId: 'session-fake', snippet: 'hi' }], hasMore: false } } }
    },
    async create({ payload }) {
      calls.push(['create', payload])
      return { rpcId: 'x', result: { ok: true, value: { sessionId: 'session-new' } } }
    },
    async rename({ payload }) {
      calls.push(['rename', payload])
      return { rpcId: 'x', result: { ok: true, value: { title: payload.title, seq: 7 } } }
    },
    async prompt({ payload }) {
      calls.push(['prompt', payload])
      return { rpcId: 'x', result: { ok: true, value: { accepted: true, echoed: payload.content[0].text } } }
    },
    async history({ payload }) {
      calls.push(['history', payload])
      return { rpcId: 'x', result: { ok: true, value: { hasMore: true, events: fakeEvents } } }
    },
    async cancel() {
      return { rpcId: 'x', result: { ok: true, value: { accepted: true } } }
    },
  },
  workspace: {
    async list() {
      return { rpcId: 'x', result: { ok: true, value: { items: [
        { workspaceId: 'ws-1', path: '/tmp/a', title: 'workspace A', sessionIds: ['session-fake'], createdAt: Date.now(), updatedAt: Date.now() },
      ], archivedSessionIds: ['session-old'] } } }
    },
    async create({ payload }) {
      calls.push(['workspace.create', payload])
      return { rpcId: 'x', result: { ok: true, value: { workspace: { workspaceId: 'ws-2', path: payload.path, title: 'workspace B', sessionIds: [], createdAt: Date.now(), updatedAt: Date.now() }, created: true } } }
    },
    async archiveSession({ payload }) {
      calls.push(['workspace.archiveSession', payload])
      return { rpcId: 'x', result: { ok: true, value: { archivedSessionIds: ['session-old', payload.sessionId] } } }
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

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`ok   ${label}`)
  else { failures++; console.log(`FAIL ${label}: ${detail}`) }
}

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

let nextId = 0
async function callTool(name, args) {
  const res = await mcp({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name, arguments: args } })
  return res.result ?? { isError: true, content: [{ type: 'text', text: JSON.stringify(res.error) }] }
}
function payloadOf(result) {
  return JSON.parse(result.content[0].text)
}

const init = await mcp({ jsonrpc: '2.0', id: ++nextId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
check('initialize', init.result?.serverInfo?.name === 'dsh-mcp-server', JSON.stringify(init.error))

const tools = await mcp({ jsonrpc: '2.0', id: ++nextId, method: 'tools/list', params: {} })
const toolNames = tools.result?.tools?.map(tool => tool.name) ?? []
check('tools/list has 11 tools', toolNames.length === 11, toolNames.join(','))

// #1: search passes an AbortSignal through to the host.
const search = await callTool('dsh_session_search', { query: 'hi' })
check('search works', search.isError !== true && payloadOf(search).items.length === 1, search.content[0].text)
check('search received signal', calls.find(c => c[0] === 'search')?.[2] === true, JSON.stringify(calls.find(c => c[0] === 'search')))

// #6: list filters.
const listAll = await callTool('dsh_session_list', {})
check('list all', payloadOf(listAll).length === 2, listAll.content[0].text)
const listRunning = await callTool('dsh_session_list', { running: false })
check('list running filter', payloadOf(listRunning).length === 1 && payloadOf(listRunning)[0].sessionId === 'session-idle', listRunning.content[0].text)
const listOne = await callTool('dsh_session_list', { sessionId: 'session-fake' })
check('list sessionId filter', payloadOf(listOne).length === 1 && payloadOf(listOne)[0].running === true, listOne.content[0].text)

// #2/#5/#8: history shapes — user text present, structured turn outcome, tool entries.
const history = await callTool('dsh_history', { sessionId: 'session-fake' })
const entries = payloadOf(history).entries
const userEntry = entries.find(e => e.role === 'user')
check('history user text', userEntry?.text === 'hi', JSON.stringify(userEntry))
const turnEntry = entries.find(e => e.role === 'turn')
check('structured turn outcome', turnEntry?.outcome === 'completed' && !('text' in turnEntry), JSON.stringify(turnEntry))
check('tool-result entry visible', entries.some(e => e.role === 'tool-result' && e.callId === 'c1' && e.isError === false), JSON.stringify(entries))
check('tool-call hidden by default', !entries.some(e => e.role === 'tool-call'), JSON.stringify(entries))
const detailed = await callTool('dsh_history', { sessionId: 'session-fake', includeToolDetails: true })
const detailedEntries = payloadOf(detailed).entries
check('includeToolDetails expands', detailedEntries.some(e => e.role === 'tool-call' && e.arguments.includes('ls'))
  && detailedEntries.find(e => e.role === 'tool-result')?.text === 'file.txt', JSON.stringify(detailedEntries))

// #3: beforeSeq passthrough.
calls.length = 0
await callTool('dsh_history', { sessionId: 'session-fake', beforeSeq: 4, maxMessages: 3 })
check('beforeSeq passed through', calls.find(c => c[0] === 'history')?.[1]?.beforeSeq === 4, JSON.stringify(calls))

// #4: unknown argument rejected by the strict schema.
const typo = await callTool('dsh_history', { sessionId: 'session-fake', limit: 3 })
check('unknown arg rejected', typo.isError === true, JSON.stringify(typo))

// #7: cancel reports wasRunning.
const cancelRunning = await callTool('dsh_cancel', { sessionId: 'session-fake' })
check('cancel wasRunning=true', payloadOf(cancelRunning).wasRunning === true, cancelRunning.content[0].text)
const cancelIdle = await callTool('dsh_cancel', { sessionId: 'session-idle' })
check('cancel wasRunning=false', payloadOf(cancelIdle).wasRunning === false, cancelIdle.content[0].text)

// #12: create with title renames afterwards.
calls.length = 0
const created = await callTool('dsh_session_create', { title: 'my title', cwd: '/tmp/x' })
check('create+rename', payloadOf(created).title === 'my title'
  && calls.find(c => c[0] === 'create')?.[1]?.cwd === '/tmp/x'
  && calls.find(c => c[0] === 'rename')?.[1]?.title === 'my title', JSON.stringify(calls))

// workspace grouping: workspaceId passthrough, mutual exclusion with cwd.
calls.length = 0
await callTool('dsh_session_create', { workspaceId: 'ws-1' })
check('create with workspaceId', calls.find(c => c[0] === 'create')?.[1]?.workspaceId === 'ws-1', JSON.stringify(calls))
const both = await callTool('dsh_session_create', { workspaceId: 'ws-1', cwd: '/tmp/x' })
check('workspaceId+cwd rejected', both.isError === true, JSON.stringify(both))

// workspace tools.
const wsList = await callTool('dsh_workspace_list', {})
const wsPayload = payloadOf(wsList)
check('workspace list', wsPayload.items[0]?.workspaceId === 'ws-1'
  && typeof wsPayload.items[0]?.createdAt === 'string'
  && wsPayload.archivedSessionIds.includes('session-old'), wsList.content[0].text)
const wsCreate = await callTool('dsh_workspace_create', { path: '/tmp/b' })
check('workspace create', payloadOf(wsCreate).created === true && payloadOf(wsCreate).workspace.workspaceId === 'ws-2', wsCreate.content[0].text)
const archived = await callTool('dsh_session_archive', { sessionId: 'session-idle' })
check('session archive', payloadOf(archived).archivedSessionIds.includes('session-idle'), archived.content[0].text)

// prompt fire-and-forget still works.
const prompt = await callTool('dsh_prompt', { text: 'ping' })
check('prompt accepted', payloadOf(prompt).accepted === true && payloadOf(prompt).sessionId === 'session-new', prompt.content[0].text)

// #9: waitSeconds resolves pending when no new turn/end appears (fake history is static).
const waited = await callTool('dsh_prompt', { sessionId: 'session-fake', text: 'ping', waitSeconds: 2 })
check('prompt waitSeconds pending', payloadOf(waited).pending === true, waited.content[0].text)

for (const dispose of disposers) await dispose()
if (failures > 0) {
  console.log(`SMOKE FAILED (${failures})`)
  process.exit(1)
}
console.log('SMOKE OK')
process.exit(0)
