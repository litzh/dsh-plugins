# dsh-vision-bridge

DSH 插件：让不支持多模态的模型通过 `describe_image` 工具调用视觉模型识别图片。

## 原理

```
主模型(纯文本) ──调用 describe_image──> 本插件 ──ctx.llm.stream──> 视觉模型
     <──返回文字描述(工具结果)──────── 本插件 <──收集文本块────────
```

- 主对话模型只看到文字描述，图片字节从不进入它的上下文。
- 图片经 `ctx.attachments.saveImage()` 持久化为规范化附件（校验/归一化由 attachment 服务完成），再以 image content block 送入视觉模型。
- 视觉调用是一次独立的辅助 LLM 调用（与 `session-title-llm` 同款模式），路由由插件 config 指定。

## 工具

`describe_image`

| 参数 | 必填 | 说明 |
|---|---|---|
| `file_path` | 是 | 图片文件绝对路径（png/jpeg/webp/gif） |
| `question` | 否 | 想问图片的问题，默认详细描述并转录文字 |

返回：图片事实（mediaType/尺寸/字节数）+ 视觉模型的文字描述。

## 配置

`cordis.patch.yml` 中 `provider` / `model` 必填，指向一个 `inputModalities` 含 `image` 的模型路由：

```yaml
config:
  provider: mlx-vlm          # 本机 MLX VLM（无网络依赖）
  model: Qwen3.8-27B-6bit
  # 远程备选：provider: hetao-ai, model: ds.public.deepseek-v4-flash-vision-exp
  # maxTokens: 4096          # 视觉调用最大输出 token
  # timeoutSeconds: 120      # 单次视觉调用超时
  # systemPrompt: ...        # 覆盖默认视觉识别指令
```

## 挂载

```sh
pnpm dsh plugin --profile web add /path/to/dsh-vision-bridge
```

`package.json` 带 `dsh.bundle.patch`，`dsh plugin add` 会自动登记到 profile 的 bundles。

## 已知限制

- 用 `node:fs` 直读文件，不经过 dsh 文件沙箱策略。
- 只支持文件路径来源；暂不支持引用会话历史中用户上传的附件（占位符 sha256 前缀）。
- 视觉路由需预先在 dsh settings（`llm-pi-ai` providers 等）中注册且凭据可用。
