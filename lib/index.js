// dsh-gui-trash 宿主 Cordis 插件（ESM）。
// 挂进 harness 的 web 组合后：
//   - 注册 /dsh-gui-trash 命令（enable / disable / status / launch）
//   - enabled 为 true 时拉起 Electron 守护；disable/dispose 时杀掉它
// 不改动 harness 源码：只消费 ctx.commands（可选）、写 $DSH_HOME/desktop/config.json。

import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export const name = 'dsh-gui-trash'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_DIR = path.join(DSH_HOME, 'desktop')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// electron/ 应用目录（相对本文件 lib/ 的上一级）。
const APP_DIR = fileURLToPath(new URL('../electron', import.meta.url))

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  port: 3080,
  launchMode: undefined, // 'source' | 'installed' | undefined => 自动
  launchRoot: undefined,
  launchCommand: undefined, // 'pnpm dsh web' | 'dsh web'
})

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
}

/** 从某目录向上找 pnpm-workspace.yaml（确定性，深度上限 8）。 */
function findWorkspace(dir) {
  let current = dir
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/** 目录是不是一个有效的 harness checkout（含 pnpm-workspace.yaml）。 */
function isHarnessCheckout(dir) {
  return typeof dir === 'string' && dir.length > 0 && fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))
}

/**
 * 判断"该用哪个 dsh"：显式 launchCommand 优先；但 source 模式的 launchRoot
 * 失效（目录被迁移 / 只剩 .git / 路径带空格）时，自动重新探测并纠正。
 */
function resolveLaunch(config) {
  // 配置仍有效：非 source 模式（installed / 手写命令），或 source 的 launchRoot 指向真 checkout。
  const cfgValid = config.launchCommand && (config.launchMode !== 'source' || isHarnessCheckout(config.launchRoot))
  if (cfgValid) return config
  const root = process.argv[1] ? findWorkspace(path.dirname(process.argv[1])) : undefined
  if (root !== undefined) {
    return { ...config, launchMode: 'source', launchRoot: root, launchCommand: 'pnpm dsh web' }
  }
  return { ...config, launchMode: 'installed', launchRoot: undefined, launchCommand: config.launchCommand || 'dsh web' }
}

/** electron 包入口在普通 Node 里导出的是可执行文件路径字符串。 */
function electronBinary() {
  try {
    return require('electron')
  } catch {
    return undefined
  }
}

/** 杀整棵进程树（Windows 用 taskkill /T /F）。 */
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

export function apply(ctx) {
  let child = null

  function launch() {
    const binary = electronBinary()
    if (typeof binary !== 'string') {
      console.error('dsh-gui-trash: 未找到 Electron 运行时（请先 pnpm install，或改用打包的 exe）')
      return false
    }
    child = spawn(binary, [APP_DIR], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return true
  }

  function stop() {
    if (child !== null && child.pid !== undefined) killTree(child.pid)
    child = null
  }

  // 启动时落一次探测结果。
  const resolved = resolveLaunch(readConfig())
  writeConfig(resolved)

  // 等 webServer 就绪后再自动拉起守护：避免 boot 期间端口尚未绑定，
  // Electron 误判"没在运行"而 spawn 第二个 dsh web 的竞态。
  if (resolved.enabled !== false) {
    ctx.inject(['webServer'], () => { launch() })
  }

  // 等 commands 服务就绪后再注册 /dsh-gui-trash 命令（随本插件卸载自动清理）。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'dsh-gui-trash',
      description: '桌面 GUI 守护：enable / disable / status / launch',
      input: { hint: 'enable | disable | status | launch' },
      handler: ({ rawInput }) => {
        const action = rawInput.trim().toLowerCase()
        const current = readConfig()
        if (action === 'enable' || action === '') {
          current.enabled = true
          writeConfig(current)
          const ok = launch()
          return ok
            ? { kind: 'success', text: '桌面 GUI 已启用' }
            : { kind: 'error', text: '未找到 Electron：请先 pnpm install，或改用打包的 exe' }
        }
        if (action === 'disable') {
          current.enabled = false
          writeConfig(current)
          stop()
          return { kind: 'success', text: '桌面 GUI 已停用' }
        }
        if (action === 'status') {
          return {
            kind: 'success',
            text: `enabled=${current.enabled === false ? 'false' : 'true'}, launchCommand=${current.launchCommand ?? '(未设置)'}`,
          }
        }
        if (action === 'launch') {
          const ok = launch()
          return ok
            ? { kind: 'success', text: '正在启动桌面 GUI' }
            : { kind: 'error', text: '未找到 Electron：请先 pnpm install，或改用打包的 exe' }
        }
        return { kind: 'error', text: '用法：/dsh-gui-trash enable | disable | status | launch' }
      },
    }))
  })

  // 卸载/删除时清理守护进程。
  ctx.effect(() => () => stop())
}
