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
const { spawn, execFile } = require('node:child_process')
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

/**
 * 解析"指向哪个 dsh"：显式 launchCommand 优先；否则向上看有没有 harness checkout。
 * @param {Record<string, unknown>} cfg
 */
function resolveLaunch(cfg) {
  if (cfg.launchCommand) return cfg
  const checkout = detectHarnessCheckout()
  if (checkout !== undefined) {
    return { ...cfg, launchMode: 'source', launchRoot: checkout, launchCommand: 'pnpm dsh web' }
  }
  return { ...cfg, launchMode: 'installed', launchRoot: undefined, launchCommand: 'dsh web' }
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
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 确保存在一个 dsh web：附着或拉起。
 * @returns {Promise<{attached: boolean}>}
 */
async function ensureDsh() {
  if (await probe(config.port)) return { attached: true }
  child = spawnDsh(config)
  spawnedByUs = true
  await waitForPort(config.port, START_WAIT_MS)
  // 拉不起来也照常开窗：窗口会显示连接错误，守护循环会继续重试。
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
  win.loadURL(`http://127.0.0.1:${config.port}/`)
  win.on('closed', () => {
    win = null
  })
}

function startReviveLoop() {
  setInterval(async () => {
    if (reviving) return
    if (await probe(config.port)) return
    reviving = true
    try {
      await ensureDsh()
    } finally {
      reviving = false
    }
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
  await ensureDsh()
  openWindow()
  startReviveLoop()
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
