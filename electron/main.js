'use strict'

/**
 * dsh-gui-trash — Electron 守护主进程。
 *
 * 把现有 `dsh web` 的界面装进原生窗口，不改动 WebUI 的任何行为：
 *   - Web-UI 已在运行  → 探测到端口后直接附着开窗，进入守护模式；
 *   - Web-UI 未运行    → 按 launchCommand 拉起一个 dsh web，等端口就绪后开窗；
 *   - 守护循环每 ~3s 探活，掉线自动重拉（"保活" = 复活，不是阻止关闭）；
 *   - 关窗 = 退出（自己拉起的 dsh 进程树一并 kill；附着的只断开不杀）；
 *   - 最小化 = 原生最小化到任务栏；不做托盘。
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_DIR = path.join(DSH_HOME, 'desktop')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  port: 3080,
  launchMode: undefined, // 'source' | 'installed' | undefined => 自动探测
  launchRoot: undefined, // source 模式：harness checkout 根目录
  launchCommand: undefined, // 'pnpm dsh web' | 'dsh web'
})

const PROBE_TIMEOUT_MS = 1200
const START_WAIT_MS = 30000
const REVIVE_INTERVAL_MS = 3000

/** 运行期可变状态。 */
let config = null
let win = null
let child = null
let spawnedByUs = false
let reviving = false
let showingApp = false // 窗口当前是否已加载出应用（false = 加载页/失败页）

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function saveConfig(next) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * 找 harness checkout：只查看本仓库（dsh-gui-trash）的上一级目录的兄弟项里
 * 有没有带 pnpm-workspace.yaml 的目录。确定性 O(兄弟数)，不是递归扫盘。
 * 扫不到就返回 undefined，由 resolveLaunch 回退为 installed（dsh web），
 * 用户可在 config.json 里手写 launchCommand/launchRoot 覆盖。
 * @returns {string | undefined} harness checkout 根目录
 */
function detectHarnessCheckout() {
  const repoRoot = path.resolve(__dirname, '..')
  const parent = path.dirname(repoRoot)
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(parent, entry.name)
    if (candidate === repoRoot) continue
    if (fs.existsSync(path.join(candidate, 'pnpm-workspace.yaml'))) return candidate
  }
  return undefined
}

/** 目录是不是一个有效的 harness checkout（含 pnpm-workspace.yaml）。 */
function isHarnessCheckout(dir) {
  return typeof dir === 'string' && dir.length > 0 && fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))
}

/**
 * 解析"指向哪个 dsh"：显式 launchCommand 优先；但 source 模式的 launchRoot
 * 失效（目录被迁移 / 只剩 .git / 路径带空格）时，自动重新探测并纠正。
 * @param {Record<string, unknown>} cfg
 */
function resolveLaunch(cfg) {
  // 配置仍有效：非 source 模式（installed / 手写命令），或 source 的 launchRoot 指向真 checkout。
  const cfgValid = cfg.launchCommand && (cfg.launchMode !== 'source' || isHarnessCheckout(cfg.launchRoot))
  if (cfgValid) return cfg
  const checkout = detectHarnessCheckout()
  if (checkout !== undefined) {
    return { ...cfg, launchMode: 'source', launchRoot: checkout, launchCommand: 'pnpm dsh web' }
  }
  return { ...cfg, launchMode: 'installed', launchRoot: undefined, launchCommand: cfg.launchCommand || 'dsh web' }
}

/**
 * 对 127.0.0.1:port 做短超时 HTTP 探活。任何响应都算"在运行"。
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function probe(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume()
        resolve(true)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

/**
 * 有界等待端口就绪。
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(port, 800)) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

/**
 * 拉起 dsh web。shell:true 兼容 Windows 上的 pnpm.cmd / dsh.cmd 垫片。
 * @param {Record<string, unknown>} cfg
 */
function spawnDsh(cfg) {
  const p = spawn(cfg.launchCommand, {
    cwd: cfg.launchRoot,
    shell: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  p.unref()
  return p
}

/**
 * 杀掉整棵进程树（Windows 用 taskkill /T /F）。
 * @param {number} pid
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    // 用同步版：确保 taskkill 在 Electron 退出前跑完，否则拉起的那棵 dsh web 会变孤儿。
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 已退出 */
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
}

/** 我们拉起的 dsh 进程是否仍在运行（启动中或已就绪）。 */
function isChildAlive() {
  return child !== null && child.exitCode === null && child.signalCode === null
}

/**
 * 确保存在一个 dsh web：附着或拉起。
 * @returns {Promise<{attached: boolean}>}
 */
async function ensureDsh() {
  if (await probe(config.port)) return { attached: true }
  // 上一个子进程还在启动/运行，就别再 spawn 第二个去抢 3080 端口。
  if (!isChildAlive()) {
    child = spawnDsh(config)
    spawnedByUs = true
  }
  await waitForPort(config.port, START_WAIT_MS)
  return { attached: false }
}

/** 窗口标题栏配色（VS Code 式，随 DSH 深浅主题切换）。 */
const TITLEBAR_HEIGHT = 36
const TITLEBAR_THEME = {
  dark: { symbolColor: '#d4d4d4', backgroundColor: '#1e1e1e' },
  light: { symbolColor: '#333333', backgroundColor: '#ffffff' },
}

function applyTheme(dark) {
  const theme = dark ? TITLEBAR_THEME.dark : TITLEBAR_THEME.light
  if (win !== null) {
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: theme.symbolColor, height: TITLEBAR_HEIGHT })
    win.setBackgroundColor(theme.backgroundColor)
  }
}

ipcMain.on('gui-theme-changed', (_event, dark) => applyTheme(Boolean(dark)))

/** 服务未就绪时的过渡加载页（内联 data URL，不依赖网络）。 */
const LOADING_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><style>',
  'html,body{height:100%;margin:0;display:flex;align-items:center;justify-content:center;',
  'font-family:system-ui,"Segoe UI",sans-serif;background:#1e1e1e;color:#d4d4d4;user-select:none}',
  '.box{text-align:center}.sp{width:28px;height:28px;border:3px solid #3c3c3c;',
  'border-top-color:#d4d4d4;border-radius:50%;margin:0 auto 16px;animation:r .8s linear infinite}',
  '@keyframes r{to{transform:rotate(360deg)}}',
  '</style></head><body><div class="box"><div class="sp"></div>',
  '<div>正在启动 DeepSeek Harness…</div></div></body></html>',
].join('')
const LOADING_URL = `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`

function showLoading() {
  showingApp = false
  if (win !== null && !win.isDestroyed()) win.loadURL(LOADING_URL)
}

/** 切到真实应用地址。 */
function loadApp() {
  if (win === null || win.isDestroyed()) return
  win.loadURL(`http://127.0.0.1:${config.port}/`)
  showingApp = true
}

function openWindow() {
  if (win !== null) {
    if (win.isMinimized()) win.restore()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: TITLEBAR_THEME.dark.symbolColor,
      height: TITLEBAR_HEIGHT,
    },
    backgroundColor: TITLEBAR_THEME.dark.backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED（导航被主动取消，属正常）；其余主框架失败（如 -102 连接被拒）→ 回到加载页，由守护循环重试。
    if (errorCode === -3 || !isMainFrame) return
    console.error(`[load failed] ${errorCode} ${errorDescription} ${validatedURL}`)
    showLoading()
  })
  win.webContents.on('did-finish-load', () => {
    console.log(`[load finished] ${win.webContents.getURL()}`)
    if (!win.webContents.getURL().startsWith('http://127.0.0.1:')) return
    for (const delay of [2500, 8000]) {
      setTimeout(() => {
        if (win === null || win.isDestroyed()) return
        win.webContents.executeJavaScript(`(() => {
          const root = document.getElementById('root')
          return {
            t: Date.now(),
            readyState: document.readyState,
            bodyLen: document.body ? document.body.innerHTML.length : -1,
            bodyChildCount: document.body ? document.body.children.length : -1,
            rootExists: !!root,
            rootInnerLen: root ? root.innerHTML.length : -1,
            bootType: typeof window.__DSH_BOOT__,
            moduleLoaderType: typeof window.__ModuleLoader__,
            dshModulesType: typeof window.__DSH_MODULES__,
            scriptCount: document.querySelectorAll('script').length,
            styleCount: document.querySelectorAll('style').length,
            bodyHtml: document.body ? document.body.innerHTML.slice(0, 200) : '',
          }
        })()`).then((info) => console.log('[diag]', JSON.stringify(info)))
          .catch((e) => console.error('[diag failed]', e.message))
      }, delay)
    }
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer gone] reason=${details.reason}`)
  })
  // 把渲染进程的 console 转发到终端，便于定位白屏。
  win.webContents.on('console-message', (_event, ...rest) => {
    let level, message, line, sourceId
    if (rest.length === 1 && rest[0] && typeof rest[0] === 'object') {
      level = rest[0].level; message = rest[0].message; line = rest[0].lineNumber; sourceId = rest[0].sourceId
    } else {
      ;[level, message, line, sourceId] = rest
    }
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })
  win.on('closed', () => {
    win = null
    showingApp = false
  })
  // 诊断白屏：记录关键资源（脚本/接口/样式/websocket）的网络请求与错误。
  const netTypes = new Set(['script', 'xhr', 'fetch', 'websocket', 'stylesheet'])
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (netTypes.has(details.resourceType)) console.log(`[net] ${details.resourceType} ${details.method} ${details.url}`)
    callback({})
  })
  win.webContents.session.webRequest.onErrorOccurred((details) => {
    if (details.resourceType !== 'mainFrame') console.log(`[net error] ${details.resourceType} ${details.error} ${details.url}`)
  })
}

/**
 * 单次同步：探测 → 没在跑就拉起 → 就绪且窗口未显示应用则切到真实地址。
 * 被 reviving 标志串行化，避免 interval 与首次调用并发 spawn。
 */
async function syncWindow() {
  if (reviving) return
  reviving = true
  try {
    if (!(await probe(config.port))) {
      await ensureDsh()
    }
    if (win !== null && !win.isDestroyed() && !showingApp && (await probe(config.port))) {
      loadApp()
    }
  } finally {
    reviving = false
  }
}

function startReviveLoop() {
  setInterval(() => {
    syncWindow()
  }, REVIVE_INTERVAL_MS)
}

/** 退出前清理：只杀自己拉起的 dsh 进程树。 */
function shutdown() {
  if (spawnedByUs && child !== null && child.pid !== undefined) killTree(child.pid)
  child = null
  spawnedByUs = false
}

async function main() {
  config = resolveLaunch(loadConfig())
  saveConfig(config)
  if (config.enabled === false) {
    app.quit()
    return
  }
  // 立即开窗显示加载页，再在后台附着/拉起 harness，就绪后自动切到应用。
  openWindow()
  showLoading()
  startReviveLoop()
  await syncWindow()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win !== null) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(main)
  app.on('before-quit', shutdown)
  app.on('window-all-closed', () => {
    app.quit()
  })
}
