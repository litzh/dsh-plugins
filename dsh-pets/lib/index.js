/**
 * dsh-pets 插件 · host 半区。
 *
 * 注册 HTTP 路由，把 ~/.dsh/pets 下的宠物暴露给浏览器：
 *   GET /__dsh-pets/list                 —— 列出所有含 pet.json 的宠物元数据
 *   GET /__dsh-pets/asset/<id>/<file>    —— 读取某宠物目录下的资源（带路径穿越防护）
 *
 * 宠物目录约定：~/.dsh/pets/<id>/ 下含 pet.json + 精灵图（如 spritesheet.webp）。
 * 每次请求 list 都实时扫描目录，所以新增宠物只需放入目录并刷新页面，无需重启。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, sep, extname, resolve } from 'node:path'

const name = 'dsh-pets'
const inject = ['webServer']

const ROUTE_PREFIX = '/__dsh-pets'

/* ---- 宠物根目录：~/.dsh/pets（$DSH_HOME 覆盖时自动跟随）----
 * 直接复刻 @deepseek-ai/dsh-home-paths 的 resolveDshHome 逻辑，避免引入
 * peerDependency —— link: 安装的插件其内部 import 会 realpath 到源目录，
 * 无法解析发行版 node_modules 里的包，故此处只用 Node 内置模块。 */
const DSH_HOME_ENV = 'DSH_HOME'
const DSH_HOME_DIR_NAME = '.dsh'

function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function petsRoot() {
  const fromEnv = process.env[DSH_HOME_ENV]
  const base = fromEnv !== void 0 && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), DSH_HOME_DIR_NAME)
  return join(resolve(expandHomePath(base)), 'pets')
}

/** id 校验：单段、无分隔符、无 . / ..。 */
function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..'
}

/** 文件名校验：单段、无分隔符、无 . / ..。 */
function isSafeFile(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 256 &&
    /^[A-Za-z0-9._-]+$/.test(file) && file !== '.' && file !== '..'
}

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(body)
}

/** 扫描 ~/.dsh/pets，返回宠物元数据数组。目录不存在时返回空数组。 */
async function scanPets() {
  const root = petsRoot()
  let dirents
  try {
    dirents = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
  const pets = []
  for (const dirent of dirents) {
    // 支持真实目录与指向目录的软链。
    let isDir = dirent.isDirectory()
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        const st = await fs.stat(join(root, dirent.name))
        isDir = st.isDirectory()
      } catch {
        isDir = false
      }
    }
    if (!isDir) continue
    const id = dirent.name
    if (!isSafeId(id)) continue
    let meta
    try {
      const raw = await fs.readFile(join(root, id, 'pet.json'), 'utf8')
      meta = JSON.parse(raw)
    } catch {
      continue // 无 pet.json 或解析失败：跳过，不作为宠物
    }
    const spritesheetPath = typeof meta.spritesheetPath === 'string' && isSafeFile(meta.spritesheetPath)
      ? meta.spritesheetPath
      : 'spritesheet.webp'
    pets.push({
      id,
      displayName: typeof meta.displayName === 'string' && meta.displayName ? meta.displayName : id,
      description: typeof meta.description === 'string' ? meta.description : '',
      spritesheetPath,
      // 浏览器直接可用的资源 URL。
      spritesheetUrl: `${ROUTE_PREFIX}/asset/${encodeURIComponent(id)}/${encodeURIComponent(spritesheetPath)}`,
      kind: typeof meta.kind === 'string' ? meta.kind : undefined,
    })
  }
  pets.sort((a, b) => a.id.localeCompare(b.id))
  return pets
}

/** 读取并返回某宠物目录下的一个资源文件（严格限制在该宠物目录内）。 */
async function serveAsset(pathname, res) {
  // pathname 形如 /__dsh-pets/asset/<id>/<file>
  const rest = pathname.slice((`${ROUTE_PREFIX}/asset/`).length)
  const slash = rest.indexOf('/')
  if (slash <= 0) { res.writeHead(404); res.end(); return }
  const id = decodeURIComponent(rest.slice(0, slash))
  const file = decodeURIComponent(rest.slice(slash + 1))
  if (!isSafeId(id) || !isSafeFile(file)) { res.writeHead(400); res.end(); return }

  const root = petsRoot()
  const petDir = join(root, id)
  const target = normalize(join(petDir, file))
  // 穿越防护：解析后的路径必须仍位于宠物目录之内。
  if (target !== petDir && !target.startsWith(petDir + sep)) {
    res.writeHead(403); res.end(); return
  }
  // 软链逃逸防护：解析真实路径后，
  //  1) 宠物目录真实位置必须仍在 pets 根目录真实位置内；
  //  2) 目标文件真实位置必须仍在宠物目录真实位置内。
  let realRoot, realPetDir, realTarget
  try {
    realRoot = await fs.realpath(root)
    realPetDir = await fs.realpath(petDir)
    realTarget = await fs.realpath(target)
  } catch (err) {
    res.writeHead(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? 404 : 500)
    res.end()
    return
  }
  if ((realPetDir !== realRoot && !realPetDir.startsWith(realRoot + sep)) ||
      (realTarget !== realPetDir && !realTarget.startsWith(realPetDir + sep))) {
    res.writeHead(403); res.end(); return
  }
  try {
    const body = await fs.readFile(realTarget)
    const ct = CONTENT_TYPES[extname(realTarget).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-cache' })
    res.end(body)
  } catch (err) {
    res.writeHead(err && err.code === 'ENOENT' ? 404 : 500)
    res.end()
  }
}

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405); res.end(); return
      }
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      try {
        if (pathname === `${ROUTE_PREFIX}/list`) {
          const pets = await scanPets()
          sendJson(res, 200, { pets })
          return
        }
        if (pathname.startsWith(`${ROUTE_PREFIX}/asset/`)) {
          await serveAsset(pathname, res)
          return
        }
        res.writeHead(404); res.end()
      } catch (err) {
        ctx.logger?.error?.(err)
        if (!res.headersSent) { res.writeHead(500) }
        res.end()
      }
    },
  })
}

export { name, inject }
