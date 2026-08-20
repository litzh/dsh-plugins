# dsh-pets

在 DSH Web GUI 内显示一个桌面宠物（像素动画），动画引擎移植自 [openai/codex](https://github.com/openai/codex) 的桌面宠物 **guga**（`codex-rs/tui/src/pets` 的前端实现，Apache-2.0，归属说明见 [NOTICE](NOTICE)）。宠物资源由 host 半区从 `~/.dsh/pets` **动态加载**，新增宠物无需重启。

## 功能

- **可拖拽悬浮窗宠物**：在对话页显示宠物，用鼠标可拖动，位置记忆在浏览器 `localStorage`。
- **设置里的「桌面宠物」子菜单**：在 DSH 设置面板新增一个 section，可开关显示、选择宠物、预览各种动画与任务状态（Running / Waiting / Review / Failed）。
- 宠物动画引擎完整移植自 guga：idle 循环 + 状态动画（8×11 精灵图，单帧 192×208）。
- **服务端动态加载**：`~/.dsh/pets/<id>/` 下每个含 `pet.json` 的目录就是一个宠物，列表实时扫描，新增后刷新页面（或点「刷新」）即生效。
- **跟随 DSH 运行状态**：宠物动画随当前会话状态自动切换——模型生成中（running）、等待用户确认（approval / question / plan 待批准 → review）、出错（promptError / lastAgentError → failed）、空闲（idle）。可在设置里关闭该联动。

## 架构（host + client 双半区）

| 半区 | 文件 | 职责 |
|---|---|---|
| host | `lib/index.js` | 注册 HTTP 前缀路由 `/__dsh-pets`，扫描 `~/.dsh/pets` 并提供列表与资源；`inject: ["webServer"]` |
| client | `lib/client.js`（由 `src/client.template.js` 构建） | 从 `/__dsh-pets/list` 拉取宠物列表，渲染悬浮窗与设置子菜单；`inject: ["slots"]` |

### host 路由

| 接口 | 说明 |
|---|---|
| `GET /__dsh-pets/list` | 扫描 `~/.dsh/pets/*/pet.json`，返回宠物元数据（含 `spritesheetUrl`） |
| `GET /__dsh-pets/asset/<id>/<file>` | 提供某宠物目录下的资源（精灵图 / pet.json），带路径穿越与软链逃逸防护 |

宠物根目录用 `$DSH_HOME`（若设置且非空）否则 `~/.dsh`，`pet.json` 的 `spritesheetPath` 字段指向目录内的精灵图文件名。

## 宠物目录约定

```
~/.dsh/pets/
└── guga/                 # 一个宠物 = 一个目录
    ├── pet.json          # { id, displayName, description, spritesheetPath, kind, ... }
    └── spritesheet.webp  # 8列×11行精灵图，单帧 192×208
```

- `pet.json` 必填：`id`（与目录名一致）、`displayName`、`spritesheetPath`（目录内文件名）。
- 可选：`description`、`kind` 等，会透传到列表展示。
- 目录名只允许字母数字 `._-`；资源文件名同理（安全校验）。
- 支持软链目录（但资源读取仍被限制在 `~/.dsh/pets` 真实路径内）。

## 挂载点（DSH client slots）

| slot | 用途 |
|---|---|
| `conversation.input.overlay` | 宠物悬浮窗（渲染为 `position:fixed`，可全页面拖拽） |
| `settings.section`（id=`pets`，label=「桌面宠物」） | 设置面板里的宠物管理子菜单 |

### 状态联动机制

`conversation.input.overlay` 是 `scope: 'session'` 的 slot，框架会向组件注入标准 props 中的 `useSession`（`SnapshotSelectorHook<ConversationSnapshot>`）。`PetFloating` 通过一次 `useSession(deriveAnimState)` 派生动画状态，映射规则（优先级从高到低）：

| DSH 会话信号 | 宠物动画 |
|---|---|
| `promptError` 或 `lastAgentError` | `failed` |
| `pending`（approval / question 等待确认）非空 | `review` |
| `running === true` | `running` |
| 其余 | `idle`（安静待机） |

开关「跟随 DSH 运行状态」关闭时强制 `idle`。设置页的「任务状态演示」按钮仍可手动预览四态动画。

## 构建

`lib/client.js` 是构建产物（`window.__ModuleLoader__.load` 格式的 client bundle），由源模板生成：

```bash
node build-client.mjs     # src/client.template.js → lib/client.js
```

改动 client 逻辑（`src/client.template.js`）后重新运行上面的命令即可。宠物资源不再内联，改动物料无需重新构建。

> 说明：本插件刻意不引入 tsdown/esbuild 等构建链，client bundle 用手写的 `__ModuleLoader__.load` 外壳 + `React.createElement` 直接产出，零额外依赖。

## 安装（git 依赖）

monorepo 下用 `#<tag>&path:` 指向子目录，tag 为仓库级版本：

```bash
dsh plugin --profile web add git+ssh://git@github.com/litzh/dsh-plugins.git#v0.1.0&path:dsh-pets
```

安装后 **需要重启 dsh web**（host 路由注册 + client 插件集变更都 take effect on restart），然后刷新浏览器页面。

> 说明：git 依赖安装不会触发 `build`，因此 `lib/client.js` 构建产物已随仓库提交；改完 `src/client.template.js` 记得 `node build-client.mjs` 后一并提交。本地开发可用 `dsh plugin --profile web add link:/绝对路径/dsh-plugins/dsh-pets`（host 半区只 import Node 内置模块，link realpath 后仍能正常加载）。

## 默认宠物

仓库自带默认宠物 `guga`（[`pets/guga/`](pets/guga/)，`pet.json` + `spritesheet.webp`）。安装后把它复制到宠物根目录即可使用：

```bash
mkdir -p ~/.dsh/pets && cp -R pets/guga ~/.dsh/pets/
```

新增宠物只需往 `~/.dsh/pets/` 放一个新目录即可。

## 版权与归属

- **动画引擎**：移植自 [openai/codex](https://github.com/openai/codex) 的 guga 桌面宠物（`codex-rs/tui/src/pets`），原版权保留，按 Apache-2.0 许可再分发，全文见 [LICENSE-APACHE](LICENSE-APACHE)，声明见 [NOTICE](NOTICE)。
- **guga 素材**：源自 [codex-pets.net 的 guga](https://codex-pets.net/#/pets/guga)；仓库内附带的是由本插件作者从 v1 精灵图升级到 v2 的版本，与原版不同。
- 其余部分以 [MIT](../LICENSE) 发布。

## 验证

1. 重启 dsh web 后打开 Web GUI，进入任意会话 → 右下角出现宠物悬浮窗，可拖动。
2. 打开设置面板 → 左侧出现「桌面宠物」子菜单，可开关显示、切换预览动画/状态。
3. 往 `~/.dsh/pets/` 放一个新宠物目录，点「刷新」或刷新页面 → 列表中立即出现新宠物。
