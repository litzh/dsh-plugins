/**
 * MCP tool registrations backed by the in-process ApiProxy service — the same
 * implementation the browser client uses, so session adoption (cold-session
 * resume with its stored preset, cwd checks) comes for free.
 *
 * Input schemas are full strict zod objects (not raw shapes): the MCP SDK
 * parses with the schema instance as-is, so an unknown argument fails
 * validation instead of being silently stripped.
 */
import { z } from 'zod'

let rpcCounter = 0

/** Server-side cap for one ApiProxy call (below the typical 60s client timeout). */
const RPC_TIMEOUT_MS = 55_000
/** Server-side cap for dsh_prompt's waitSeconds (leaves room within client timeouts). */
const MAX_WAIT_SECONDS = 45
/** Text caps for tool detail expansion, so one tool result cannot flood the reply. */
const TOOL_TEXT_CAP = 2000
const TOOL_ARGS_CAP = 1000

/**
 * Call one ApiProxy method and unwrap its business result.
 * @param {object} apiProxy - the ctx.apiProxy service.
 * @param {string} domain - e.g. 'sessions'.
 * @param {string} method - e.g. 'prompt'.
 * @param {object} payload - the RPC payload.
 * @returns {Promise<*>} the response value.
 * @throws {Error} on a business error (`code: message`) or timeout.
 */
async function rpc(apiProxy, domain, method, payload, timeoutMs = RPC_TIMEOUT_MS) {
  const rpcId = `mcp-${Date.now()}-${rpcCounter++}`
  // Several ApiProxy methods (search, subagents.*) take a required AbortSignal
  // as their second parameter; passing one uniformly is harmless for the rest.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await apiProxy[domain][method]({ rpcId, payload }, controller.signal)
    if (!response.result.ok) {
      const error = response.result.error
      throw new Error(`${error.code}: ${error.message}`)
    }
    return response.result.value
  } finally {
    clearTimeout(timer)
  }
}

/** JSON tool result envelope. */
function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** Error tool result envelope. */
function failure(error) {
  return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true }
}

/** Join the text parts of one message content array. */
function textOf(content) {
  return (content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
}

/** Truncate one string to cap characters, marking the cut. */
function truncate(text, cap) {
  return text.length <= cap ? text : `${text.slice(0, cap)}…[truncated ${text.length - cap} chars]`
}

/**
 * Extract one readable entry from a session event, or null to skip it.
 *
 * Event data shapes (packages/core/session): `user/message` data IS the
 * UserMessage itself (`data.content`); `assistant/message` and `tool/result`
 * wrap theirs (`data.message.content`). A tool result message holds one
 * `tool-result` content block whose own `content` carries the text.
 * @param {object} entry - one HistoryEntry ({ event, view? }).
 * @param {boolean} includeToolDetails - expand tool call arguments and result text.
 */
function summarizeEvent(entry, includeToolDetails) {
  const { event } = entry
  const data = event.data ?? {}
  switch (event.type) {
    case 'user/message': {
      const source = data.source?.kind
      return {
        seq: event.seq,
        role: 'user',
        text: textOf(data.content),
        // Synthetic injections (file-change notices, skill content, cron, …)
        // share this event type; tag anything that is not a direct human prompt.
        ...(source !== undefined && source !== 'user' ? { source } : {}),
      }
    }
    case 'assistant/message': {
      const content = data.message?.content ?? []
      const text = textOf(content)
      const tools = content.filter(part => part.type === 'tool-call' || part.type === 'toolCall')
        .map(part => part.name ?? part.toolName).filter(Boolean)
      return {
        seq: event.seq,
        role: 'assistant',
        text,
        ...(data.interrupted === true ? { interrupted: true } : {}),
        ...(tools.length > 0 ? { toolCalls: tools } : {}),
      }
    }
    case 'tool/call': {
      if (!includeToolDetails) return null
      return { seq: event.seq, role: 'tool-call', name: data.name, arguments: truncate(String(data.arguments ?? ''), TOOL_ARGS_CAP) }
    }
    case 'tool/result': {
      const block = data.message?.content?.[0]
      const inner = block?.type === 'tool-result' ? block.content : []
      const entryOut = {
        seq: event.seq,
        role: 'tool-result',
        callId: data.message?.source?.callId ?? block?.toolCallId ?? null,
        isError: block?.isError === true || data.error !== undefined,
      }
      if (includeToolDetails) entryOut.text = truncate(textOf(inner), TOOL_TEXT_CAP)
      return entryOut
    }
    case 'turn/end': {
      const reason = data.reason ?? {}
      return {
        seq: event.seq,
        role: 'turn',
        outcome: reason.kind ?? 'unknown',
        ...(reason.kind === 'error' && reason.error !== undefined
          ? { error: { code: reason.error.code, message: reason.error.message } }
          : {}),
      }
    }
    default:
      return null
  }
}

/**
 * Find the newest turn/end with seq above `baselineSeq` in one history page.
 * @returns {{ outcome: string, seq: number } | null}
 */
function latestTurnEnd(entries, baselineSeq) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.role === 'turn' && entry.seq > baselineSeq) {
      return { outcome: entry.outcome, seq: entry.seq }
    }
  }
  return null
}

/**
 * Register every MCP tool on one server instance.
 * @param {object} server - the McpServer.
 * @param {object} apiProxy - the ctx.apiProxy service.
 * @param {object} bridge - the ApprovalBridge.
 */
export function registerTools(server, apiProxy, bridge) {
  server.registerTool('dsh_session_list', {
    description: 'List DSH sessions with id, title, running state, cwd and last activity time. '
      + 'Optional filters: sessionId (exact, for polling one session\'s state), running, cwd.',
    inputSchema: z.object({
      sessionId: z.string().optional(),
      running: z.boolean().optional(),
      cwd: z.string().optional(),
    }).strict(),
  }, async ({ sessionId, running, cwd }) => {
    try {
      const value = await rpc(apiProxy, 'sessions', 'list', {})
      let items = value.items
      if (sessionId !== undefined) items = items.filter(item => item.sessionId === sessionId)
      if (running !== undefined) items = items.filter(item => item.running === running)
      if (cwd !== undefined) items = items.filter(item => item.cwd === cwd)
      return json(items.map(item => ({
        sessionId: item.sessionId,
        title: item.projections?.values?.title ?? null,
        running: item.running,
        cwd: item.cwd ?? null,
        updatedAt: new Date(item.updatedAt).toISOString(),
      })))
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_session_search', {
    description: 'Full-text search over session content; returns matching session ids with snippets.',
    inputSchema: z.object({ query: z.string().min(1).max(500) }).strict(),
  }, async ({ query }) => {
    try {
      return json(await rpc(apiProxy, 'sessions', 'search', { query }))
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_session_create', {
    description: 'Create a new DSH session. Defaults to the host working directory and the default agent preset.',
    inputSchema: z.object({
      cwd: z.string().optional(),
      agentPreset: z.string().optional(),
      title: z.string().min(1).optional(),
    }).strict(),
  }, async ({ cwd, agentPreset, title }) => {
    try {
      const created = await rpc(apiProxy, 'sessions', 'create', {
        ...(cwd === undefined ? {} : { cwd }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      })
      if (title === undefined) return json(created)
      try {
        const renamed = await rpc(apiProxy, 'sessions', 'rename', { sessionId: created.sessionId, title })
        return json({ ...created, title: renamed.title })
      } catch (error) {
        // The session exists; only the naming failed (e.g. no session-title service).
        return json({ ...created, titleError: String(error?.message ?? error) })
      }
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_prompt', {
    description: 'Queue a text prompt into a DSH session and return immediately (accepted). '
      + 'A cold session is resumed automatically with its full history. '
      + 'Omit sessionId to create a fresh session first. '
      + 'With waitSeconds the call blocks until the next turn ends (returns its outcome), '
      + 'an approval for this session goes pending (awaitingApproval), or the wait times out (pending). '
      + 'Note: when the prompt queues behind an already-running turn, that turn\'s end also resolves the wait. '
      + 'Without waitSeconds, poll dsh_history for the reply.',
    inputSchema: z.object({
      sessionId: z.string().optional(),
      text: z.string().min(1),
      mode: z.union([z.literal('queue'), z.literal('steer')]).optional(),
      clientTimeZone: z.string().optional(),
      waitSeconds: z.number().positive().optional(),
    }).strict(),
  }, async ({ sessionId, text, mode, clientTimeZone, waitSeconds }) => {
    try {
      let target = sessionId
      if (target === undefined) {
        const created = await rpc(apiProxy, 'sessions', 'create', {})
        target = created.sessionId
      }
      const waitMs = waitSeconds === undefined ? 0 : Math.min(waitSeconds, MAX_WAIT_SECONDS) * 1000
      let baselineSeq = -1
      if (waitMs > 0) {
        const tail = await rpc(apiProxy, 'sessions', 'history', { sessionId: target, maxMessages: 1 })
        baselineSeq = tail.events.at(-1)?.event.seq ?? -1
      }
      const value = await rpc(apiProxy, 'sessions', 'prompt', {
        sessionId: target,
        mode: mode ?? 'queue',
        content: [{ type: 'text', text }],
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      })
      const accepted = { ...value, sessionId: target }
      if (waitMs <= 0) return json(accepted)

      const deadline = Date.now() + waitMs
      const pollMs = 1000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollMs))
        if (bridge.list().some(approval => approval.sessionId === target)) {
          return json({ ...accepted, awaitingApproval: true })
        }
        const page = await rpc(apiProxy, 'sessions', 'history', { sessionId: target, maxMessages: 30 })
        const entries = page.events.map(event => summarizeEvent(event, false)).filter(Boolean)
        const ended = latestTurnEnd(entries, baselineSeq)
        if (ended !== null) return json({ ...accepted, outcome: ended.outcome, turnEndSeq: ended.seq })
      }
      return json({ ...accepted, pending: true })
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_history', {
    description: 'Read recent conversation of a DSH session (user/assistant messages, tool results and structured turn outcomes) '
      + 'for polling a prompt result. When hasMore is true, pass the oldest returned seq as beforeSeq to page further back. '
      + 'Set includeToolDetails to also expand tool call arguments and tool result text (truncated).',
    inputSchema: z.object({
      sessionId: z.string(),
      maxMessages: z.number().int().positive().optional(),
      beforeSeq: z.number().int().nonnegative().optional(),
      includeToolDetails: z.boolean().optional(),
    }).strict(),
  }, async ({ sessionId, maxMessages, beforeSeq, includeToolDetails }) => {
    try {
      const value = await rpc(apiProxy, 'sessions', 'history', {
        sessionId,
        ...(maxMessages === undefined ? {} : { maxMessages }),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })
      const entries = value.events.map(event => summarizeEvent(event, includeToolDetails === true)).filter(Boolean)
      return json({ sessionId, hasMore: value.hasMore, entries })
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_cancel', {
    description: 'Stop a session\'s active turn; queued prompts stay queued. '
      + 'wasRunning reports whether the session had an active turn when the cancel was issued '
      + '(false means there was nothing to cancel).',
    inputSchema: z.object({ sessionId: z.string() }).strict(),
  }, async ({ sessionId }) => {
    try {
      const list = await rpc(apiProxy, 'sessions', 'list', {})
      const wasRunning = list.items.find(item => item.sessionId === sessionId)?.running === true
      const value = await rpc(apiProxy, 'sessions', 'cancel', { sessionId })
      return json({ ...value, wasRunning })
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_approvals_list', {
    description: 'List pending tool-approval questions waiting for a human decision.',
    inputSchema: z.object({}).strict(),
  }, async () => json(bridge.list()))

  server.registerTool('dsh_approval_respond', {
    description: 'Approve or reject one pending approval question by id from dsh_approvals_list.',
    inputSchema: z.object({
      id: z.string(),
      outcome: z.union([z.literal('allowed-once'), z.literal('rejected')]),
    }).strict(),
  }, async ({ id, outcome }) => {
    const settled = bridge.respond(id, outcome)
    return settled
      ? json({ settled: true, id, outcome })
      : failure(new Error(`unknown or already-settled approval id: ${id}`))
  })
}
