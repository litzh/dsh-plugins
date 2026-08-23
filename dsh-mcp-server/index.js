/**
 * DSH plugin entry: serve MCP over Streamable HTTP on 127.0.0.1, backed by the
 * web host's in-process ApiProxy service plus an approval waterfall answerer.
 *
 * Loaded through the user patch layer (~/.dsh/cordis.patch.yml), which applies
 * to every profile. The plugin waits for the `apiProxy` service via
 * ctx.inject(): profiles that never provide it (CLI/headless) simply never
 * start the server. Diagnostics append to plugin.log next to this file
 * because loader/HMR failures do not surface in the host UI.
 *
 * Config (insert entry `config:` or DSH_MCP_PORT env): { port?: number }.
 * @module dsh-mcp-server-local
 */
import http from 'node:http'
import { appendFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ApprovalBridge } from './approvals.js'
import { registerTools } from './tools.js'

export const name = 'dsh-mcp-server'

const DEFAULT_PORT = 3079
const BIND_HOST = '127.0.0.1'
const LOG_FILE = new URL('./plugin.log', import.meta.url)

/** Append one diagnostic line to plugin.log. */
function log(...args) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${args.map(String).join(' ')}\n`)
  } catch { /* logging must never break plugin loading */ }
}

log('module evaluated')

/**
 * @param {object} ctx - plugin context.
 * @param {{ port?: number }} [config] - insert-entry config.
 */
export function apply(ctx, config) {
  const port = Number(config?.port ?? process.env.DSH_MCP_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`dsh-mcp-server: invalid port ${String(config?.port ?? process.env.DSH_MCP_PORT)}`)
  }
  log('apply entered, port', port)

  ctx.inject(['apiProxy'], (scope) => {
    log('apiProxy service available')
    ctx.effect(() => {
      const bridge = new ApprovalBridge(log)
      bridge.attach(ctx)

      const server = http.createServer((req, res) => {
        void handleRequest(scope.apiProxy, bridge, req, res).catch((error) => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(error?.message ?? error) }))
        })
      })

      const listening = new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, BIND_HOST, resolve)
      })
      listening.then(
        () => log(`listening on http://${BIND_HOST}:${port}/mcp`),
        error => log(`listen failed: ${String(error?.message ?? error)}`),
      )

      return async () => {
        log('disposing')
        bridge.dispose()
        await listening.catch(() => {})
        await new Promise(resolve => server.close(resolve))
      }
    }, 'dsh-mcp-server.http()')
  })
}

/**
 * Handle one HTTP request with a fresh stateless MCP server+transport pair
 * (documented stateless pattern: no session id, no GET/DELETE streams).
 */
async function handleRequest(apiProxy, bridge, req, res) {
  const url = new URL(req.url ?? '/', `http://${BIND_HOST}`)
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end('not found')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed')
    return
  }
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400).end('body is not JSON')
    return
  }

  const server = new McpServer({ name: 'dsh-mcp-server', version: '0.1.0' })
  registerTools(server, apiProxy, bridge)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

/** @returns {Promise<string>} the full request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
