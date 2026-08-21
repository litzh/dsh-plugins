# dsh-beacon

将 DSH 的运行状态上报到 [beacon](https://github.com/litzh/beacon) 监控面板（移植自 pi 扩展 `beacon.ts`）。

## 上报内容

| 时机 | 级别 |
|---|---|
| 进程启动 / 正常停止 | info |
| 心跳（默认 60s，带 TTL，面板可据此发现崩溃/失联） | info |
| 会话启动 / 结束 | info |
| 用户提交新任务 | info |
| agent 空闲（任务完成，等待输入） | info |
| 危险命令执行前（`rm -rf`、`sudo`、`git push`、`kubectl apply` 等） | warning |
| 工具执行失败 | warning |
| 弹出提示等待确认（工具审批 `approval/asked`、模型提问 `ask_user_question`） | action_required（处理完后自动 ACK） |
| agent 执行异常（如模型报错，无需确认，不闪烁） | warning |

上报失败（beacon 未运行、网络异常）一律静默，不影响会话。多会话场景下每条事件带 hostname 与会话 cwd。进程异常崩溃时无法自我上报，靠心跳 TTL 过期发现。

## 安装

```bash
dsh plugin --profile web add git+ssh://git@github.com/litzh/dsh-plugins.git#v0.3.1&path:dsh-beacon
```

安装后重启 `dsh web`。默认配置开箱即用。

## 配置

```yaml
- insert:
    - id: beacon
      name: 'dsh-beacon'
      config:              # 以下为默认值，可不写
        url: http://localhost:7331
        token: ''          # 空时读环境变量 BEACON_TOKEN；url 空时读 BEACON_URL
        source: dsh
        heartbeatSeconds: 60    # 心跳间隔，0 关闭
        confirmTtlSeconds: 600  # 「等待确认」事件的 TTL
```

## 工具

| 工具 | 用途 |
|---|---|
| `beacon_send` | 手动发一条消息到 beacon 面板，测试连通性 |

## 测试

```bash
node test.mjs
```

依赖均为 peerDependencies，需在能解析到 `@deepseek-ai/*` 包的环境下运行（如将本目录放入/链接到已初始化 dsh profile 的 `node_modules` 旁）。
