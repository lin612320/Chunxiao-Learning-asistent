# 春晓学习助手 · 悬浮球面板**版面守门**（无头 Edge + CDP）
#
#   powershell -File scripts/smoke-ball-panel.ps1
#
# 验的是「**渲染出来的面板版面**」：两个输入框 / 两个按钮 / 抓取模式按钮
# 是否真的存在、是否**完整落在窗口内**、是否互不重叠。
#
# 这一层是 0.7.0 一次真实事故换来的（见 docs/16 §九）：
#   R5 的「收起」把窗口压到 64px，而收起态内容约需 100px → **按钮行被裁到窗口外**，
#   "展开"按钮又恰好在那一行里 → 用户既点不到按钮也回不到展开态，且状态被持久化、重启无效。
#   Rust 单测 / 桥接冒烟 / 桌面真机冒烟都碰不到它：它们的对象是数据与主程序，
#   **没有任何一层渲染过面板本身**。所以这里补上。
#
# 退出码：0 = 全过；1 = 有断言失败；2 = 环境不可用（未装 Edge / CDP 起不来）→ 记 SKIP，不冒充通过。

$ErrorActionPreference = "Continue"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Panel = Join-Path $Root "floating-ball\src\renderer\panel.html"

# 找无头 Edge（与 make-icons.ps1 / smoke-ui.ps1 同一套探测顺序）
$EdgeCandidates = @(
  (Join-Path ${env:ProgramFiles} "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
)
$Edge = $EdgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Edge) {
  Write-Host "[SKIP] 未找到无头 Edge —— 面板版面守门跳过（不冒充通过）" -ForegroundColor Yellow
  exit 2
}
if (-not (Test-Path $Panel)) {
  Write-Host "[SKIP] 未找到面板文件：$Panel" -ForegroundColor Yellow
  exit 2
}

Push-Location $Root
& node (Join-Path $PSScriptRoot "smoke-ball-panel.mjs") --edge $Edge --panel $Panel
$code = $LASTEXITCODE
Pop-Location

Write-Host ""
if ($code -eq 0) { Write-Host "面板版面守门退出码：0" -ForegroundColor Green }
elseif ($code -eq 2) { Write-Host "面板版面守门退出码：2（环境不可用，SKIP）" -ForegroundColor Yellow }
else { Write-Host "面板版面守门退出码：$code（有断言失败）" -ForegroundColor Red }
exit $code
