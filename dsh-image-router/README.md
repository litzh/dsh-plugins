# dsh-image-router

多模态图片自动路由（移植自 pi 扩展 `image-router.ts`）。当当前模型不支持图片输入时，自动把消息里的图片交给配置的多模态模型识别，把文字识别结果注入会话——主力模型继续用你的编码模型。

> dsh 的适配器对不支持图片的模型会**直接报 `UNSUPPORTED_CONTENT` 硬错误**，所以该插件在 dsh 里是必需品而非增强。

## 工作方式

- **自动路由**：监听 `agent/pre-step`，消息含图片且当前模型不支持图片时，用识图模型识别后替换进入该 step 的消息。**durable log 中原图保留**，只替换模型可见内容；识别失败则原样放行并告警。
- **识图后端**：进程内直接调用 `ctx.llm.stream`，不走子进程。识图模型可为 `settings.yaml` 里配置的任意供应商模型（包括自定义供应商的本地模型），默认 DeepSeek 官方 `deepseek-v4-flash`。
- **能力判定**：`ctx.llm.resolveModelInfo` 的 `inputModalities`，按 provider/model 缓存。当前模型取自 `agent.options` 或会话最近的 request header；会话首条消息能力未知时按 `unknownCapability` 策略处理（默认 `pass` 放行）。
- **宿主准入放行**：`dsh-host-apiproxy` 会在图片进入收件箱前按 `inputModalities` 直接拒绝并让前端弹 banner「当前模型不支持图片」，导致 `agent/pre-step` 永远轮不到执行。插件因此包装 `ctx.llm.resolveModelInfo`，对「声明了 `inputModalities` 但不含 `image`」的模型补上 `image` 骗过准入；真实能力判定仍走包装前的原始实现，路由逻辑不受影响。
- **识图工具**：`image_describe` 供模型运行中主动识别本地图片文件（截图、报错图等），经附件服务入库后识别。

## 安装

```bash
dsh plugin --profile web add git+ssh://git@github.com/litzh/dsh-plugins.git#v0.3.0&path:dsh-image-router
```

安装后重启 `dsh web`。

## 配置

```yaml
- insert:
    - id: image-router
      name: 'dsh-image-router'
      config:                         # 以下为默认值，可不写
        enabled: true
        provider: deepseek-official   # 识图模型的 provider 路由
        model: deepseek-v4-flash
        maxTokens: 4096
        unknownCapability: pass       # 首条消息能力未知时：pass 放行 / route 路由
```

识图模型必须声明支持图片输入（供应商配置的 `input` 含 `image`）。

## 工具

| 工具 | 用途 |
|---|---|
| `image_describe` | 识别本地图片文件（paths + 可选 prompt），仅供不支持图片输入的模型使用 |

## 测试

```bash
node test.mjs
```

依赖均为 peerDependencies，需在能解析到 `@deepseek-ai/*` 包的环境下运行（如将本目录放入/链接到已初始化 dsh profile 的 `node_modules` 旁）。
