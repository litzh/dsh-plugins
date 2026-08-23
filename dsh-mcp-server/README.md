# dsh-mcp-server

把运行中的 DSH Web 宿主封装成 MCP server：MCP 客户端（Claude Code、Cursor、另一个 DSH、launchd 脚本等）可以通过 MCP 工具列出会话、注入 prompt、读取历史、处理审批。

- 传输：MCP Streamable HTTP，`http://127.0.0.1:3079/mcp`（只绑回环，无鉴权）
- 形态：cordis function plugin，作为 profile bundle 加载（`dsh plugin add` 自动激活）
- 后端：进程内 `ctx.apiProxy`（与浏览器同一套实现，冷会话自动 resume、保留原 preset）；审批走每个 Agent 上的 `approval/request` waterfall answerer，与浏览器 answerer 竞争，先答先生效
- 无 `apiProxy` 的 profile（CLI/headless）自动跳过，不影响其他用法

## 安装

```bash
dsh plugin --profile web add git+ssh://git@github.com/litzh/dsh-plugins.git#v0.5.0&path:dsh-mcp-server
```

安装后重启 `dsh web`。插件会被装入 `~/.dsh/profiles/web/node_modules/dsh-mcp-server`，并因声明了 `dsh.bundle` 自动加入 profile 的 bundle 列表，无需手工 insert。

加载成功后 `~/.dsh/profiles/web/node_modules/dsh-mcp-server/plugin.log` 会出现 `listening on http://127.0.0.1:3079/mcp`；也可 `lsof -iTCP:3079 -sTCP:LISTEN` 确认。

## 配置

默认配置（端口 3079）开箱即用。如需覆盖端口，在 `~/.dsh/profiles/web/cordis.patch.yml` 中加一条同 id 的配置覆盖：

```yaml
- id: dsh-mcp-server
  name: 'dsh-mcp-server'
  config:
    port: 3081        # 也可用 DSH_MCP_PORT 环境变量覆盖
```

## 工具

| 工具 | 说明 |
|---|---|
| `dsh_session_list` | 列出会话（id、标题、running、cwd、最近活动）；可选过滤 `sessionId`（精确查单个，适合轮询状态）、`running`、`cwd` |
| `dsh_session_search` | 全文搜索会话内容 |
| `dsh_session_create` | 新建会话；可选 `cwd`（默认宿主工作目录）、`agentPreset`、`title`（create 后经 rename 设置，失败会返回 `titleError` 但会话已建好） |
| `dsh_prompt` | 注入文本 prompt。默认 fire-and-forget 立即返回 `accepted`（省略 sessionId 则先建会话）；传 `waitSeconds`（≤45s）则阻塞等到本轮结束并返回结构化 `outcome`、审批挂起（`awaitingApproval`）或超时（`pending`） |
| `dsh_history` | 读取会话最近消息（user/assistant/tool-result/结构化 turn 结局）。`hasMore: true` 时把最旧一条的 `seq` 作为 `beforeSeq` 继续翻页；`includeToolDetails: true` 展开工具调用入参与结果文本（截断） |
| `dsh_cancel` | 停止当前轮（排队消息保留）；`wasRunning` 表明取消时是否真有活跃轮次 |
| `dsh_approvals_list` | 列出等待人工决策的审批 |
| `dsh_approval_respond` | 按 id 批准（`allowed-once`）或拒绝（`rejected`） |

行为约定：

- **参数严格校验**：传错参数名（如 `limit` 而非 `maxMessages`）会立即报 validation error，不会静默忽略。
- **turn 结局是结构化的**：`{ role: "turn", outcome: "completed" | "aborted" | "blocked" | "error" | "max-tokens" | "interrupted" }`，error 时附带 `error.code` / `error.message`，不要做字符串匹配。
- **宿主能力边界**：会话删除/归档宿主 API 不支持，会话只增不减；`waitSeconds` 在 prompt 排队于另一个进行中的轮次时，前一个轮次的结束也会解除等待。

## 客户端接入

这是一个标准的 MCP server（Streamable HTTP 传输），端点为 `http://127.0.0.1:3079/mcp`。**不是普通 REST API**：客户端必须讲 MCP 协议（POST JSON-RPC，先 `initialize` 握手再调用工具），不能只靠 curl 打业务请求。工具清单、参数 schema 由 `tools/list` 在运行时自描述，客户端接入后自动发现，无需额外文档。

常见客户端配置：

**Claude Code**

```sh
claude mcp add --transport http dsh http://127.0.0.1:3079/mcp
```

**Cursor / 通用 mcp.json**

```json
{
  "mcpServers": {
    "dsh": { "url": "http://127.0.0.1:3079/mcp" }
  }
}
```

**另一个 DSH**（经 `@deepseek-ai/dsh-mcp-client`，写入该 DSH 的 patch 层）：

```yaml
- insert:
    - id: mcp-dsh
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dsh
        transport: streamable-http
        url: 'http://127.0.0.1:3079/mcp'
```

接入后工具以 `mcp__dsh__dsh_session_list` 等限定名出现。

**脚本/调试**（直接 JSON-RPC，注意 `accept` 头必须同时声明两种类型，响应可能是 SSE 流，取最后的 `data:` 行）：

```sh
curl -N -X POST http://127.0.0.1:3079/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"debug","version":"0"}}}'
```

完整调用序列参考 `test/smoke.mjs`。

## 开发

```sh
pnpm install --ignore-workspace   # 安装 @modelcontextprotocol/sdk + zod
node test/smoke.mjs               # 离线冒烟（假 ApiProxy + 真实 HTTP）
```

本地开发可不经 `dsh plugin add`，直接在 patch 层以文件路径 insert：

```yaml
- insert:
    - id: dsh-mcp-server
      name: '/path/to/dsh-plugins/dsh-mcp-server/index.js'
```

改动插件源码后需要重启 DSH（插件模块不在 patch 文件 HMR 的监听范围内）。

## 注意

- 无鉴权只绑 `127.0.0.1`：本机任何进程都可驱动你的 agent，请勿改为对外绑定。
- `dsh_prompt` 默认 fire-and-forget；传 `waitSeconds` 可阻塞等结局。不用 waitSeconds 的长任务用 `dsh_history` 轮询，审批用 `dsh_approvals_list` / `dsh_approval_respond` 处理，否则卡在审批上的轮次不会推进。
