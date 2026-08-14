// dsh-gui-trash preload（CJS）。
// 1) 顶部加一条 VS Code 式拖拽条，让窗口可拖动；窗口控件由系统叠在右上角。
// 2) 预留标题栏高度，让 DSH 内容从标题栏下方开始。
// 3) 监听 DSH 的深浅主题（body[data-ds-dark-theme]）并回报主进程，切换标题栏配色。

const { ipcRenderer } = require('electron')

const TITLEBAR_HEIGHT = 36

function isDark() {
  return document.body.hasAttribute('data-ds-dark-theme')
}

function report() {
  ipcRenderer.send('gui-theme-changed', isDark())
}

window.addEventListener('DOMContentLoaded', () => {
  // 拖拽条：透明、固定顶部，仅承担 -webkit-app-region:drag。
  const bar = document.createElement('div')
  bar.id = 'gui-titlebar'
  bar.style.cssText = `position:fixed;top:0;left:0;right:0;height:${TITLEBAR_HEIGHT}px;-webkit-app-region:drag;z-index:2147483647;`
  document.body.appendChild(bar)

  // 预留标题栏空间。
  document.body.style.paddingTop = `${TITLEBAR_HEIGHT}px`
  document.body.style.boxSizing = 'border-box'

  // 主题上报 + 监听变化。
  report()
  const observer = new MutationObserver(report)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
})
