# dsh-bark

通过 [Bark](https://github.com/Finb/Bark) 向 iOS 设备推送消息。注册一个 `bark_push` 工具，模型/用户可用它把通知发到手机。

底层调用 Bark 服务的 REST 接口（[API V2](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md)）`POST /push`。

## 工具

| 工具 | 用途 |
|---|---|
| `bark_push` | 向 iOS 设备推送一条通知 |

### `bark_push` 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `body` | string（必填） | 通知正文 |
| `title` | string | 通知标题（字号大于正文） |
| `subtitle` | string | 通知副标题 |
| `deviceKey` | string | 目标设备密钥；不填用默认配置 |
| `level` | string | `critical` / `active` / `timeSensitive` / `passive` |
| `sound` | string | 铃声；不填用默认铃声 |
| `group` | string | 分组；不填用默认分组 |
| `url` | string | 点击通知跳转的 URL |
| `icon` | string | 图标 URL（仅 iOS 15+）；不填用默认图标 |
| `badge` | number | App 图标角标数字 |
| `call` | boolean | 为 true 时持续响铃 30 秒 |
| `isArchive` | boolean | 为 true 时让 App 存档该通知 |

返回 `{ sent: boolean, code: number|null, message: string }`。请求失败（服务不可达、密钥错误等）不抛异常，返回 `sent: false` 与错误信息。

## 安装

```bash
dsh plugin --profile web add 'git+ssh://git@github.com/litzh/dsh-plugins.git#<tag>&path:dsh-bark'
```

安装后重启 `dsh web`。插件声明了 `dsh.bundle`，会自动加入 profile 的 bundle 列表并插入 entry（`id: dsh-bark`），**无需手工 insert**。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 里对已插入的 `dsh-bark` entry 做 config 覆盖即可（**不要再 `insert` 一次，否则会 `duplicate loader entry id: dsh-bark`**）：

```yaml
- id: dsh-bark
  config:                       # 以下均为默认值，可按需覆盖
    server: https://api.day.app # Bark 服务地址；自建服务改这里。缺省读环境变量 BARK_SERVER
    deviceKey: ''               # 默认设备密钥；缺省读环境变量 BARK_DEVICE_KEY
    defaultSound: ''            # 默认铃声
    defaultGroup: ''            # 默认分组
    defaultIcon: ''             # 默认图标 URL（仅 iOS 15+）
```

设备密钥获取：在手机上安装 Bark App，App 首页会显示你的推送地址，形如
`https://api.day.app/你的Key/`，其中的 `你的Key` 即 `deviceKey`。

- `server` 缺省时读环境变量 `BARK_SERVER`
- `deviceKey` 缺省时读环境变量 `BARK_DEVICE_KEY`
- 工具参数 `deviceKey` 优先级高于配置/环境变量

## 测试

```bash
node test.mjs
```

依赖均为 peerDependencies，需在能解析到 `@deepseek-ai/*` 包的环境下运行（如将本目录放入/链接到已初始化 dsh profile 的 `node_modules` 旁）。
