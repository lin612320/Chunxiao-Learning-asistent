// 全局选词：通过模拟 Ctrl+C 复制当前选中文字，再读取剪贴板
// 保留并恢复原剪贴板内容，避免污染

const { clipboard } = require('electron');
const { exec } = require('child_process');

// 通过 PowerShell 发送 Ctrl+C（WScript.Shell），稳定且免 native 编译
function sendCtrlC() {
  return new Promise((resolve) => {
    const ps =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$w=New-Object -ComObject WScript.Shell; $w.SendKeys('^c');";
    exec(`powershell -NoProfile -Command "${ps}"`, () => resolve());
  });
}

// 读取选中文本：记录原剪贴板，触发复制，轮询剪贴板直到出现新内容或超时，再恢复
async function grabSelection() {
  const before = clipboard.readText();
  await sendCtrlC();
  // 轮询剪贴板，直到出现新内容或超时（最多 ~720ms）
  let got = '';
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 60));
    const cur = clipboard.readText();
    if (cur && cur !== before) { got = cur.trim(); break; }
  }
  // 恢复用户原剪贴板内容（不污染）
  if (before) clipboard.writeText(before);
  return got;
}

module.exports = { grabSelection, sendCtrlC };
