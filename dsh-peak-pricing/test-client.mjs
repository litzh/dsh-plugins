// dsh-peak-pricing 浏览器半区逻辑测试：
// 物化 lib/client.js 的 __ModuleLoader__ factory，用假 ctx / react / document
// 验证：模型目录读取 → 高峰判定 → InputShell.submit 拦截 → 提交确认走
// host /submit-confirm 接口（对话窗口问题由 host 负责）→ defer 不提交并保留
// 草稿 → continue 后调用原始 submit。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

const CONFIG_URL = '/__dsh-peak-pricing/config'
const SUBMIT_CONFIRM_URL = '/__dsh-peak-pricing/submit-confirm'

function createStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function createFakeDocument() {
  const listeners = new Set()
  return {
    visibilityState: 'visible',
    head: { appendChild() {} },
    querySelector() {
      return null
    },
    createElement() {
      return {
        dataset: {},
        set textContent(_value) {},
      }
    },
    addEventListener(_name, listener) {
      listeners.add(listener)
    },
    removeEventListener(_name, listener) {
      listeners.delete(listener)
    },
  }
}

function delay(ms = 5) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail(message)
}

async function bootController() {
  let submitted = 0
  let lastMode = null
  const shell = {
    submit(mode) {
      submitted += 1
      lastMode = mode
    },
    actions: {
      submit() {
        shell.submit('queue')
      },
    },
  }

  const modelStore = createStore({
    current: { provider: 'deepseek-official', model: 'deepseek-chat' },
    routable: true,
    groups: [],
    failures: [],
    status: 'ready',
    error: null,
  })
  const modelDirectory = {
    store: modelStore,
    load() {
      return Promise.resolve({})
    },
  }

  const sessionsList = createStore({ current: 'session-1' })
  const scope = { scopeTag: 'session-1' }
  const sessions = {
    list: sessionsList,
    scope() {
      return scope
    },
  }

  let registeredSlot = null
  const ctx = {
    get(name) {
      if (name === 'modelDirectories') {
        return {
          directoryFor() {
            return modelDirectory
          },
        }
      }
      if (name === 'conversation') {
        return {
          input: {
            for() {
              return shell
            },
          },
        }
      }
      return null
    },
    sessions,
    slots: {
      inject(_key, callback) {
        callback()
        return () => {}
      },
      register(options) {
        registeredSlot = { options }
        return () => {}
      },
    },
  }

  const submitConfirmCalls = []
  const document = createFakeDocument()
  const sandbox = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url, options) => {
      if (url === CONFIG_URL) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              ok: true,
              present: true,
              rules: [{
                provider: 'deepseek-official',
                model: 'deepseek-chat',
                timezone: 'UTC',
                periods: [{ start: '00:00', end: '00:00' }],
              }],
              remindIntervalMinutes: 15,
              promptTimeoutSeconds: 0,
            }
          },
        }
      }
      if (url === SUBMIT_CONFIRM_URL) {
        const call = {
          body: JSON.parse(options.body),
          resolve: null,
          async settle(action) {
            this.resolve({
              ok: true,
              status: 200,
              async json() {
                return { ok: true, action }
              },
            })
          },
        }
        submitConfirmCalls.push(call)
        return new Promise(resolve => {
          call.resolve = resolve
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    },
    document,
    Symbol,
    Object,
    Date,
    Math,
    Number,
    String,
    Set,
    Map,
    WeakMap,
    Error,
    TypeError,
    Intl,
    JSON,
    crypto,
    URL,
    AbortController,
  }
  sandbox.window.window = sandbox.window
  sandbox.window.__ModuleLoader__ = {
    load(handoff) {
      sandbox.handoff = handoff
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox)

  const react = {
    createElement: (...args) => ({ args }),
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    useEffect() {},
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
  }
  const moduleExports = sandbox.handoff.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  })

  const dispose = moduleExports.apply(ctx)
  return {
    ctx,
    shell,
    document,
    registeredSlot,
    dispose,
    submitConfirmCalls,
    getSubmitted: () => submitted,
    getLastMode: () => lastMode,
  }
}

test('提交确认走对话窗口 host 提问：defer 不提交，continue 调用原始 submit', async () => {
  const harness = await bootController()
  try {
    const inject = harness.registeredSlot.options.inject()
    const store = inject.store

    await waitFor(
      () => store.getSnapshot().configState === 'ready' && store.getSnapshot().peak?.peak === true,
      '配置与模型目录应就绪并判定为高峰',
    )
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.configState, 'ready')
    assert.equal(snapshot.model.provider, 'deepseek-official')
    assert.equal(snapshot.peak.peak, true)

    // 高峰提交：不再创建浏览器模态，而是等待 host 的提交确认请求。
    harness.shell.submit('queue')
    await waitFor(() => harness.submitConfirmCalls.length === 1, '应调用 host submit-confirm 接口')
    assert.equal(harness.getSubmitted(), 0, 'host 回答前不得调用原始 submit')
    assert.deepEqual(harness.submitConfirmCalls[0].body, {
      sessionId: 'session-1',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })

    // 确认问题打开期间的重复提交手势应被吞掉。
    harness.shell.actions.submit()
    await delay(10)
    assert.equal(harness.submitConfirmCalls.length, 1, '重复提交不得发起第二个确认请求')
    assert.equal(harness.getSubmitted(), 0)

    // 用户在对话窗口选择“暂不开始”：输入草稿保留，不调用原始 submit。
    await harness.submitConfirmCalls[0].settle('defer')
    await delay(10)
    assert.equal(harness.getSubmitted(), 0, '暂不开始不得调用原始 submit')

    // 再次提交并选择“继续提交”：最终调用原始 submit，mode 保持 queue。
    harness.shell.actions.submit()
    await waitFor(() => harness.submitConfirmCalls.length === 2, '第二次提交应再次请求确认')
    await harness.submitConfirmCalls[1].settle('continue')
    await waitFor(() => harness.getSubmitted() === 1, '继续后应调用原始 submit')
    assert.equal(harness.getLastMode(), 'queue')
  } finally {
    harness.dispose()
  }
})
