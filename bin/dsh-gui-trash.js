#!/usr/bin/env node
// dsh-gui-trash 命令行入口（ESM）。
// 安装后 `npx dsh-gui-trash` / `dsh-gui-trash` 直接启动 Electron 守护。

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

let electronPath
try {
  // electron 包入口在普通 Node 里导出的是可执行文件路径字符串。
  electronPath = require('electron')
} catch {
  electronPath = undefined
}

if (typeof electronPath !== 'string') {
  console.error('dsh-gui-trash: 未找到 Electron 运行时。')
  console.error('  源码环境：pnpm install && pnpm dsh-gui-trash')
  console.error('  安装环境：直接运行打包产物 dsh-gui-trash.exe（pnpm run build:exe 生成）。')
  process.exit(1)
}

const electronDir = fileURLToPath(new URL('../electron', import.meta.url))
const child = spawn(electronPath, [electronDir], { stdio: 'inherit', windowsHide: false })

child.on('error', (error) => {
  console.error(`dsh-gui-trash: 启动 Electron 失败：${error.message}`)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 0))
