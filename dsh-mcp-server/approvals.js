/**
 * Approval bridge: forwards DSH approval questions to MCP clients.
 *
 * DSH decides approvals through the scope-filtered `approval/request`
 * waterfall. Waterfall dispatch is serial and outermost-first: a listener
 * that returns a pending promise without calling next() starves every later
 * listener. The host apiproxy answerer registers at app boot and pends until
 * a browser answers, so this bridge MUST register with `prepend: true` to sit
 * ahead of it; it then races its own pending answer against `next()`, keeping
 * the browser answerer reachable and letting whichever side answers first win.
 * Scope dispatch admits untagged listener contexts globally (the same pattern
 * the apiproxy answerer relies on), so one standing registration observes
 * every agent's questions. The pending entry is dropped as soon as the
 * question settles by any means.
 */
import { randomUUID } from 'node:crypto'

export class ApprovalBridge {
  /** @type {Map<string, { info: object, resolve: (outcome: string) => void }>} */
  #pending = new Map()
  /** @type {Array<() => void>} */
  #cleanups = []
  /** @param {(message: string) => void} [log] - diagnostic sink (plugin.log). */
  constructor(log = () => {}) {
    this.log = log
  }

  /**
   * Register the standing answerer (prepended — see module doc). Call inside
   * a ctx.effect so disposal runs on plugin teardown.
   * @param {object} ctx - plugin context.
   */
  attach(ctx) {
    this.#cleanups.push(ctx.on('approval/request', (req, next) => this.#onRequest(req, next), { prepend: true }))
  }

  async #onRequest(req, next) {
    const id = randomUUID()
    const info = {
      id,
      sessionId: String(req.agent.session.id),
      toolName: req.toolName,
      callId: req.callId ?? null,
      reason: req.reason ?? null,
      askedAt: new Date().toISOString(),
    }
    this.log(`approval asked: ${req.toolName} (${id})`)
    const answered = new Promise((resolve) => {
      this.#pending.set(id, { info, resolve })
      req.signal?.addEventListener('abort', () => {
        // The service already settles the question as cancelled on abort; this
        // only keeps the pending map from leaking the entry.
        this.#pending.delete(id)
      }, { once: true })
    })
    try {
      return await Promise.race([answered, next()])
    } finally {
      // Settled by us, by another answerer, or by abort: the question is
      // closed either way, so the MCP-visible entry must not linger.
      this.#pending.delete(id)
    }
  }

  /**
   * Snapshot of every unanswered approval question.
   * @returns {object[]}
   */
  list() {
    return [...this.#pending.values()].map(entry => entry.info)
  }

  /**
   * Settle one pending question.
   * @param {string} id - pending id from {@link list}.
   * @param {'allowed-once' | 'rejected'} outcome - the client's decision.
   * @returns {boolean} false when the id is unknown or already settled.
   */
  respond(id, outcome) {
    const entry = this.#pending.get(id)
    if (entry === undefined) return false
    this.#pending.delete(id)
    entry.resolve(outcome)
    return true
  }

  /** Reject everything still pending and unregister the answerer. */
  dispose() {
    for (const entry of this.#pending.values()) entry.resolve('cancelled')
    this.#pending.clear()
    for (const cleanup of this.#cleanups.splice(0)) cleanup()
  }
}
