/**
 * MCP tool registrations backed by the in-process ApiProxy service — the same
 * implementation the browser client uses, so session adoption (cold-session
 * resume with its stored preset, cwd checks) comes for free.
 */
import { z } from 'zod'

let rpcCounter = 0

/**
 * Call one ApiProxy method and unwrap its business result.
 * @param {object} apiProxy - the ctx.apiProxy service.
 * @param {string} domain - e.g. 'sessions'.
 * @param {string} method - e.g. 'prompt'.
 * @param {object} payload - the RPC payload.
 * @returns {Promise<*>} the response value.
 * @throws {Error} on a business error (`code: message`).
 */
async function rpc(apiProxy, domain, method, payload) {
  const rpcId = `mcp-${Date.now()}-${rpcCounter++}`
  const response = await apiProxy[domain][method]({ rpcId, payload })
  if (!response.result.ok) {
    const error = response.result.error
    throw new Error(`${error.code}: ${error.message}`)
  }
  return response.result.value
}

/** JSON tool result envelope. */
function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** Error tool result envelope. */
function failure(error) {
  return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true }
}

/** Extract one readable text line from a session event, or null to skip it. */
function summarizeEvent(entry) {
  const { event } = entry
  const data = event.data ?? {}
  switch (event.type) {
    case 'user/message': {
      const text = (data.message?.content ?? [])
        .filter(part => part.type === 'text').map(part => part.text).join('\n')
      return { seq: event.seq, role: 'user', text }
    }
    case 'assistant/message': {
      const content = data.message?.content ?? []
      const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      const tools = content.filter(part => part.type === 'tool-call' || part.type === 'toolCall')
        .map(part => part.name ?? part.toolName).filter(Boolean)
      return { seq: event.seq, role: 'assistant', text, ...(tools.length > 0 ? { toolCalls: tools } : {}) }
    }
    case 'turn/end':
      return { seq: event.seq, role: 'system', text: `turn ended: ${data.reason?.kind ?? 'unknown'}` }
    default:
      return null
  }
}

/**
 * Register every MCP tool on one server instance.
 * @param {object} server - the McpServer.
 * @param {object} apiProxy - the ctx.apiProxy service.
 * @param {object} bridge - the ApprovalBridge.
 */
export function registerTools(server, apiProxy, bridge) {
  server.registerTool('dsh_session_list', {
    description: 'List DSH sessions with id, title, running state, cwd and last activity time.',
    inputSchema: {},
  }, async () => {
    try {
      const value = await rpc(apiProxy, 'sessions', 'list', {})
      return json(value.items.map(item => ({
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
    inputSchema: { query: z.string().min(1).max(500) },
  }, async ({ query }) => {
    try {
      return json(await rpc(apiProxy, 'sessions', 'search', { query }))
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_session_create', {
    description: 'Create a new DSH session. Defaults to the host working directory and the default agent preset.',
    inputSchema: { cwd: z.string().optional() },
  }, async ({ cwd }) => {
    try {
      return json(await rpc(apiProxy, 'sessions', 'create', { ...(cwd === undefined ? {} : { cwd }) }))
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_prompt', {
    description: 'Queue a text prompt into a DSH session and return immediately (accepted). '
      + 'A cold session is resumed automatically with its full history. '
      + 'Omit sessionId to create a fresh session first. Poll dsh_history for the reply.',
    inputSchema: {
      sessionId: z.string().optional(),
      text: z.string().min(1),
      mode: z.union([z.literal('queue'), z.literal('steer')]).optional(),
      clientTimeZone: z.string().optional(),
    },
  }, async ({ sessionId, text, mode, clientTimeZone }) => {
    try {
      let target = sessionId
      if (target === undefined) {
        const created = await rpc(apiProxy, 'sessions', 'create', {})
        target = created.sessionId
      }
      const value = await rpc(apiProxy, 'sessions', 'prompt', {
        sessionId: target,
        mode: mode ?? 'queue',
        content: [{ type: 'text', text }],
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      })
      return json({ ...value, sessionId: target })
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_history', {
    description: 'Read recent conversation of a DSH session (user/assistant messages and turn outcomes) for polling a prompt result.',
    inputSchema: {
      sessionId: z.string(),
      maxMessages: z.number().int().positive().optional(),
    },
  }, async ({ sessionId, maxMessages }) => {
    try {
      const value = await rpc(apiProxy, 'sessions', 'history', {
        sessionId,
        ...(maxMessages === undefined ? {} : { maxMessages }),
      })
      const entries = value.events.map(summarizeEvent).filter(Boolean)
      return json({ sessionId, hasMore: value.hasMore, entries })
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_cancel', {
    description: 'Stop a session\'s active turn; queued prompts stay queued.',
    inputSchema: { sessionId: z.string() },
  }, async ({ sessionId }) => {
    try {
      return json(await rpc(apiProxy, 'sessions', 'cancel', { sessionId }))
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_approvals_list', {
    description: 'List pending tool-approval questions waiting for a human decision.',
    inputSchema: {},
  }, async () => json(bridge.list()))

  server.registerTool('dsh_approval_respond', {
    description: 'Approve or reject one pending approval question by id from dsh_approvals_list.',
    inputSchema: {
      id: z.string(),
      outcome: z.union([z.literal('allowed-once'), z.literal('rejected')]),
    },
  }, async ({ id, outcome }) => {
    const settled = bridge.respond(id, outcome)
    return settled
      ? json({ settled: true, id, outcome })
      : failure(new Error(`unknown or already-settled approval id: ${id}`))
  })
}
