# dsh-peak-pricing

DSH Web 插件：按供应商/模型配置高峰计价时段。高峰期提交消息时在**对话窗口内提问**确认，长任务运行中进入高峰时在**下一个工具调用前**提问确认；支持继续 / 本次高峰不再提醒 / 暂停任务。高峰期间输入框旁的**模型名显示为橙色**，低谷期完全无感、无额外标识。

## 功能

- 配置走 DSH 标准用户设置（`ctx.settings`）：存于 `~/.dsh/settings.yaml` 的 `peak-pricing` 段（由 `@deepseek-ai/dsh-settings-file` 提供，热重载实时生效）；`cordis.patch.yml` 的 `config` 只作为组合 base（settings 未覆盖时的回退默认）。
- `POST /__dsh-peak-pricing/submit-confirm` 接收 `{ sessionId, provider, model }`，在 host 侧通过 `ctx.userQuestions` 提问并返回 `continue` / `defer`。
- 前端从 settings scope 订阅 `peak-pricing` 段，并从当前会话的 model directory 读取选中的 `provider` / `model`，自行判断高峰/低谷。
- 高峰标识：高峰期输入框右侧模型选择器里的**模型名变为橙色**（通过 `document.body` 上的 `dshpp-peak` 类驱动，命中 composer 卡片内的模型选择器触发器）；低谷期无任何标识。进入/离开高峰时各弹一条自动消失的临时通知。
- 高峰提交拦截：前端只拦截 `InputShell.submit` 并调用 host 的 submit-confirm 接口，问题由 `ctx.userQuestions` 渲染在当前会话的对话窗口（不再是浏览器自定义模态框）；选择「继续提交」才调用原 submit，「暂不开始」不提交，输入框草稿原样保留。
- 长任务运行中进入高峰：在 `tools/execute` 前拦截（顶层、root agent），在对话窗口提问「继续执行 / 本次高峰不再提醒 / 暂停任务」。host 侧使用 `agent.session.requestHeader().config` 判断本 step 实际计费的 provider/model；只有尚无 request/header 时才回退到 `agent.options`。
  - 暂停不 abort：当前工具调用替换为错误结果，并注入“等待用户新消息”上下文，turn 自然停止，会话日志与现场完整保留；用户发送新消息后继续。
  - 继续后按 `remindIntervalMinutes` 冷却重复提醒。
  - 本次高峰不再提醒按“实际 provider/model + 规则 + period + 名义日期”记忆，切换模型或进入下一个高峰窗口后自动恢复提醒。
- 提问超时：`promptTimeoutSeconds: 0` 一直等待；`> 0` N 秒无响应自动继续（提交确认与运行中确认都遵循）。
- 高峰结束自动继续：可选（`autoContinueOnPeakEnd`）。开启后，提问等待期间若离开高峰时段（或规则被改后不再命中），自动按「继续」处理——适合人不在电脑前的场景；提问文案会注明这一点。
- **设置页**：DSH 设置面板中有「高峰计价」独立页面，可可视化编辑规则与全部选项，保存经 `settings` 服务写回 `settings.yaml` 的 `peak-pricing` 段，保存即生效（见下文）。

## 设置页

设置面板 → 「高峰计价」：

- **全局选项**：运行中提醒间隔、提问超时、高峰结束自动继续开关。
- **规则编辑器**：增删规则；每条规则可填供应商（可留空）、模型通配模式、IANA 时区（可留空），时段支持星期点选与起止时间，可增删时段。
- 「保存」把整份配置经 `ctx.settings` 写回 `~/.dsh/settings.yaml` 的 `peak-pricing` 段（host 侧 schema + `normalizeConfig` 校验，非法配置返回错误并在页面展示，磁盘旧配置不受影响）；「重载」放弃未保存的修改。

## 配置

配置存于 `~/.dsh/settings.yaml` 的 `peak-pricing` 段（完整可复制示例见 [examples/peak-pricing.settings.yaml](examples/peak-pricing.settings.yaml)；JSON 形态见 [examples/peak-pricing.json](examples/peak-pricing.json)）：

```yaml
peak-pricing:
  rules:
    - provider: deepseek-official
      model: deepseek-*
      timezone: Asia/Shanghai
      periods:
        - days: [mon, tue, wed, thu, fri]
          start: '09:00'
          end: '12:00'
        - days: [mon, tue, wed, thu, fri]
          start: '14:00'
          end: '18:00'
        - start: '22:00'
          end: '02:00'
    - provider: anthropic
      model: anthropic/claude-*
      periods:
        - start: '00:00'
          end: '00:00'
  remindIntervalMinutes: 15
  promptTimeoutSeconds: 0
  autoContinueOnPeakEnd: false
```

也可在 profile 的 `cordis.patch.yml` 或 home 级的 `~/.dsh/cordis.patch.yml` 按 `id: dsh-peak-pricing` 覆盖整份 `config`（该 config 即组合 base，settings 未覆盖时生效）；settings 的用户层优先于组合 base。

### 字段

- `rules`：规则数组，按顺序匹配；任意一条命中活跃 period 即为高峰。
  - `provider`：供应商精确匹配（兼容 `*` / `?` 通配）；**可省略**，缺省为 `*`（匹配所有供应商），此时用 `model` 写全名模式（如 `deepseek/deepseek-*`）即可。
  - `model`：模型通配模式，支持 `*` / `?`；同时匹配裸模型名与 `provider/model` 全名，所以既可写 `claude-*`，也可写 `anthropic/claude-*`。
  - `timezone`：IANA 时区，缺省为本机时区。
  - `periods[].days`：`sun`…`sat`，缺省表示每天；显式 `[]` 表示不生效。
  - `periods[].start` / `end`：`"HH:mm"`。`start < end` 当天；`start > end` 跨午夜（名义日期为 `start` 所在日）；`start == end` 全天。
- `remindIntervalMinutes`：运行中继续后重复提醒间隔（分钟），默认 `15`；`0` 表示每个工具边界都询问。
- `promptTimeoutSeconds`：`0` 一直等待确认；`> 0` N 秒无响应后自动继续，默认 `0`。
- `autoContinueOnPeakEnd`：默认 `false`。为 `true` 时，提问等待期间每 15 秒复查一次高峰状态，离开高峰（或规则被改后不再命中）即取消提问并自动继续。

## 从旧版迁移（`~/.dsh/peak-pricing.json`）

旧版本把配置存在独立的 `~/.dsh/peak-pricing.json`。迁移只需把该 JSON 的内容放进 `~/.dsh/settings.yaml` 的 `peak-pricing` 段（字段结构不变）：

```bash
# 把旧 JSON 转成 YAML 段后合并进 settings.yaml（字段名/结构完全一致）
python3 - <<'PY'
import json, yaml, pathlib
home = pathlib.Path.home()
src = home / '.dsh' / 'peak-pricing.json'
dst = home / '.dsh' / 'settings.yaml'
if src.exists():
    data = json.loads(src.read_text())
    doc = {}
    if dst.exists():
        doc = yaml.safe_load(dst.read_text()) or {}
    doc['peak-pricing'] = data
    dst.write_text(yaml.safe_dump(doc, allow_unicode=True, sort_keys=False))
    src.rename(src.with_suffix('.json.bak'))
    print('已迁移到', dst, '；旧文件备份为', src.with_suffix('.json.bak'))
else:
    print('未找到', src)
PY
```

迁移后重启 `dsh web`（或直接刷新浏览器页面），之后在设置页保存即走 settings。

## 安装

```bash
dsh plugin --profile web add link:/绝对路径/dsh-plugins/dsh-peak-pricing
# 或 git 依赖（tag 为仓库级版本）
dsh plugin --profile web add 'git+ssh://git@github.com/litzh/dsh-plugins.git#v0.11.0&path:dsh-peak-pricing'
```

本插件 host 半区 peer 依赖 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`（由安装它的 profile 提供）。安装后重启 `dsh web`，刷新浏览器页面。host 路由注册与 client 插件集变更都在重启时生效。

## 构建

`lib/client.js` 是提交到仓库的构建产物（`window.__ModuleLoader__.load` 格式）；改动 `src/client.template.js` 或 `src/schedule.js` 后重新生成：

```bash
node build-client.mjs
```

host 半区是纯源码入口（`src/index.js`），无构建步骤。

## 验证

```bash
node test.mjs          # host 半区（schedule 纯逻辑 + tools/execute 拦截 + submit-confirm）
node test-client.mjs   # 浏览器半区（settingsScope 配置读取 + 提交拦截）
```

> 测试需要 `@deepseek-ai/schemastery` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-settings` 可解析（如通过 profile 的 node_modules，或 checkout 内建 symlink/安装 peer 依赖）。

手工验证：

1. 打开设置面板 → 「高峰计价」：添加一条全天规则（时段起止都填 `00:00`）并保存。
2. 打开任意会话并选中规则命中的模型：输入框旁的模型名变为橙色。
3. 输入内容后回车或点发送：当前会话对话窗口出现「继续提交 / 暂不开始」提问，选「暂不开始」后文本仍留在输入框。
4. 发起长任务后把规则改为当前时刻覆盖的时段（或使用全天规则）：模型下一次工具调用前出现「继续执行 / 本次高峰不再提醒 / 暂停任务」。
5. 选「暂停任务」：当前工具不执行，任务自然停止；发送新消息后任务继续。
