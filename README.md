# dsh-plugins

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 的 Web 插件集。

## 插件

| 插件 | 说明 |
|---|---|
| [dsh-peak-pricing](dsh-peak-pricing/) | 按供应商/模型配置高峰计价时段：高峰期提交消息与长任务工具调用前在对话窗口提问确认，支持继续 / 本次高峰不再提醒 / 暂停任务，状态栏常显当前高峰或低谷。 |
| [dsh-pets](dsh-pets/) | 在 Web GUI 内显示一个可拖拽的像素桌面宠物（动画引擎移植自 OpenAI codex 的 guga），跟随会话运行状态切换动画，并在设置面板提供宠物管理子菜单。 |
| [dsh-beacon](dsh-beacon/) | 运行状态上报到 [beacon](https://github.com/litzh/beacon) 监控面板：进程/会话生命周期、任务开始/完成、危险命令、工具失败、等待确认（可 ACK）、异常与心跳。 |
| [dsh-mcp-server](dsh-mcp-server/) | 把运行中的 DSH Web 宿主封装成 MCP server（Streamable HTTP，127.0.0.1）：外部 MCP 客户端（Claude Code、Cursor、另一个 DSH、脚本等）可列出/搜索/归档会话、在工作区内创建会话、注入 prompt、读取历史、处理审批。 |
| [dsh-vision-bridge](dsh-vision-bridge/) | 让不支持多模态的模型通过 `describe_image` 工具把图片识别委托给视觉模型：主模型只收到文字描述，图片字节不进入它的上下文。 |

## 安装

各插件相互独立，通过 git 依赖安装（tag 为仓库级版本，`path:` 指向插件子目录）：

```bash
# 高峰计价提醒
dsh plugin --profile web add 'git+ssh://git@github.com/litzh/dsh-plugins.git#v0.1.0&path:dsh-peak-pricing'

# 桌面宠物
dsh plugin --profile web add 'git+ssh://git@github.com/litzh/dsh-plugins.git#v0.1.0&path:dsh-pets'

# beacon 状态上报
dsh plugin --profile web add 'git+ssh://git@github.com/litzh/dsh-plugins.git#v0.3.1&path:dsh-beacon'

# MCP server（对外暴露会话/审批能力）
dsh plugin --profile web add 'git+ssh://git@github.com/litzh/dsh-plugins.git#v0.6.1&path:dsh-mcp-server'

# 视觉桥（纯文本模型委托视觉模型识图）
dsh plugin --profile web add 'git+ssh://git@github.com/litzh/dsh-plugins.git#v0.7.0&path:dsh-vision-bridge'
```

安装后重启 `dsh web` 并刷新浏览器页面。各插件的详细配置与验证方法见各自目录下的 README。

## 许可

本仓库整体以 [MIT](LICENSE) 发布。其中 `dsh-pets` 的宠物动画引擎移植自
[openai/codex](https://github.com/openai/codex)（Apache-2.0），该部分保留原版权与许可，
详见 [dsh-pets/NOTICE](dsh-pets/NOTICE)。

---

Web plugins for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh):

- **dsh-peak-pricing** — prompts for confirmation before submitting messages or running tool calls during configurable provider/model peak-pricing windows.
- **dsh-pets** — a draggable pixel desktop pet inside the Web GUI that follows session state, with a settings panel for pet management.
- **dsh-beacon** — reports runtime status to a [beacon](https://github.com/litzh/beacon) monitoring panel: process/session lifecycle, task start/finish, dangerous commands, tool failures, confirmation waits (with ACK), errors, and heartbeats.
- **dsh-mcp-server** — exposes the running DSH web host as an MCP server (Streamable HTTP on 127.0.0.1) so external MCP clients (Claude Code, Cursor, another DSH, scripts) can list/search/archive sessions, create sessions inside workspaces, inject prompts, read history, and handle approvals.
- **dsh-vision-bridge** — lets a text-only model delegate image recognition to a vision model via a `describe_image` tool; the primary model only receives the textual description and image bytes never enter its context.

Install any plugin as a git dependency (see above), restart `dsh web`, and refresh the page. Released under MIT; the dsh-pets animation engine is ported from openai/codex (Apache-2.0, see `dsh-pets/NOTICE`).
