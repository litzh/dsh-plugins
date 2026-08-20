# dsh-plugins

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 的 Web 插件集。

## 插件

| 插件 | 说明 |
|---|---|
| [dsh-peak-pricing](dsh-peak-pricing/) | 按供应商/模型配置高峰计价时段：高峰期提交消息与长任务工具调用前在对话窗口提问确认，支持继续 / 本次高峰不再提醒 / 暂停任务，状态栏常显当前高峰或低谷。 |
| [dsh-pets](dsh-pets/) | 在 Web GUI 内显示一个可拖拽的像素桌面宠物（动画引擎移植自 OpenAI codex 的 guga），跟随会话运行状态切换动画，并在设置面板提供宠物管理子菜单。 |

## 安装

两个插件各自独立，通过 git 依赖安装（tag 为仓库级版本，`path:` 指向插件子目录）：

```bash
# 高峰计价提醒
dsh plugin --profile web add git+ssh://git@github.com/litzh/dsh-plugins.git#v0.1.0&path:dsh-peak-pricing

# 桌面宠物
dsh plugin --profile web add git+ssh://git@github.com/litzh/dsh-plugins.git#v0.1.0&path:dsh-pets
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

Install either plugin as a git dependency (see above), restart `dsh web`, and refresh the page. Released under MIT; the dsh-pets animation engine is ported from openai/codex (Apache-2.0, see `dsh-pets/NOTICE`).
