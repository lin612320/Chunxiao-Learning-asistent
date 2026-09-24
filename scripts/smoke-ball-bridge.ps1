# 春晓学习助手 · 悬浮球桥接冒烟测试
#
#   powershell -File scripts/smoke-ball-bridge.ps1
#
# 验证「主程序 → 悬浮球」反向桥接链路（Rust 侧 ball_show / ball_hide / ball_prefill / ball_quit 依赖它）：
#   1. 启动 Electron 悬浮球（--child）
#   2. 依次写 %APPDATA%\chunxiao-ball\to-ball.json 的 show / prefill / quit
#   3. 断言球进程日志出现对应命令回显，且 quit 后进程退出
#
# 这条链路是母本踩过坑的地方（"命令经控制文件下发而非二次进程传参"），值得长期保留为回归项。

$ErrorActionPreference = "Continue"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$BallDir = Join-Path $Root "floating-ball"
$Electron = Join-Path $BallDir "node_modules\electron\dist\electron.exe"
$BridgeDir = Join-Path $env:APPDATA "chunxiao-ball"
$CtrlFile = Join-Path $BridgeDir "to-ball.json"

if (-not (Test-Path $Electron)) {
  Write-Host "[SKIP] 未找到 Electron：$Electron" -ForegroundColor Yellow
  Write-Host "       请先在 floating-ball/ 下执行 npm install"
  exit 2
}
if (-not (Test-Path $BridgeDir)) { New-Item -ItemType Directory -Force -Path $BridgeDir | Out-Null }
Remove-Item $CtrlFile -ErrorAction SilentlyContinue

# 本测试会往悬浮球配置里写入一个**假的 API Key**（用于验证 BYOK 配置同步），
# 结束时必须还原，否则会污染用户真实配置 → 先备份，末尾还原。
$BallCfg = Join-Path $BridgeDir "chunxiao-ball-config.json"
$BallCfgBackup = if (Test-Path $BallCfg) { Get-Content $BallCfg -Raw -Encoding UTF8 } else { $null }

$log = Join-Path $env:TEMP "cx-ball-bridge.out"
$err = Join-Path $env:TEMP "cx-ball-bridge.err"
Remove-Item $log, $err -ErrorAction SilentlyContinue

function Send-Ctrl([string]$cmd, [hashtable]$extra) {
  $body = @{ ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); cmd = $cmd }
  if ($extra) { foreach ($k in $extra.Keys) { $body[$k] = $extra[$k] } }
  $json = $body | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($CtrlFile, $json, [System.Text.UTF8Encoding]::new($false))
  Write-Host ("  → 写入 to-ball.json: {0}" -f $json)
}

$pass = 0; $fail = 0
function Assert([string]$name, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host ("  [PASS] {0}" -f $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [FAIL] {0} — {1}" -f $name, $detail) -ForegroundColor Red }
}

Write-Host "启动悬浮球：$Electron" -ForegroundColor Cyan
$proc = Start-Process -FilePath $Electron -ArgumentList @($BallDir, "--child") -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError $err
Start-Sleep -Seconds 5
Assert "进程启动存活" (-not $proc.HasExited) "进程已退出"

# ---- show ----
Write-Host "`n[1/6] 测试 show" -ForegroundColor Cyan
Send-Ctrl "show" $null
Start-Sleep -Seconds 3
$t1 = Get-Content $log -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
Assert "球收到 show 命令" ($t1 -match "收到春晓命令: show") "日志中未见 show 回显"

# ---- prefill ----
Write-Host "`n[2/6] 测试 prefill（预填文本）" -ForegroundColor Cyan
Send-Ctrl "prefill" @{ text = "春晓桥接冒烟测试文本" }
Start-Sleep -Seconds 3
$t2 = Get-Content $log -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
Assert "球收到 prefill 命令" ($t2 -match "收到春晓命令: prefill") "日志中未见 prefill 回显"

# ---- AI 配置同步（BYOK 配套）----
Write-Host "`n[3/6] 测试 AI 配置随命令同步（BYOK）" -ForegroundColor Cyan
$plainKey = "sk-chunxiao-sync-test-0001"
Send-Ctrl "show" @{ ai = @{ baseURL = "https://api.deepseek.com"; apiKey = $plainKey; model = "deepseek-chat" } }
Start-Sleep -Seconds 3
$t3 = Get-Content $log -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
Assert "球收到并应用 AI 配置" ($t3 -match "已同步主程序的 AI 配置") "日志中未见配置同步回显"

$cfgFile = $BallCfg
Assert "球配置已落盘" (Test-Path $cfgFile) "未找到 $cfgFile"
if (Test-Path $cfgFile) {
  $cfgRaw = Get-Content $cfgFile -Encoding UTF8 -Raw
  Assert "落盘的是加密 Key（enc. 前缀）" ($cfgRaw -match '"apiKey":\s*"enc\.') "配置里未出现 enc. 前缀的 apiKey"
  Assert "落盘不含明文 Key" (-not ($cfgRaw -match [regex]::Escape($plainKey))) "配置文件里出现了明文 Key！"
  Assert "baseURL 已同步" ($cfgRaw -match "api\.deepseek\.com") "配置里未同步 baseURL"
  Assert "model 已同步" ($cfgRaw -match "deepseek-chat") "配置里未同步 model"
  # R5：面板尺寸必须是配置里的**显式字段** —— 球靠它记住用户调过的尺寸。
  # 缺了它，面板每次启动都回到默认 420x620，"可缩放"就成了假的。
  Assert "R5 面板宽度键存在" ($cfgRaw -match '"panelWidth"') "配置里没有 panelWidth"
  Assert "R5 面板高度键存在" ($cfgRaw -match '"panelHeight"') "配置里没有 panelHeight"
  # R5.1：「收起」已整块删除，配置里**不该再有** panelCollapsed；
  #   而且高度必须 ≥ 420 —— 旧版收起时会把 64 写进去，那会让面板变成一道残疾窄条
  #   （输入框只剩 38px、按钮行被裁在窗口外，连"展开"都点不到）。
  Assert "R5.1 已无 panelCollapsed（收起功能已删除）" (-not ($cfgRaw -match '"panelCollapsed"')) "配置里仍有 panelCollapsed"
  if ($cfgRaw -match '"panelHeight"\s*:\s*(\d+)') {
    Assert "R5.1 面板高度不小于 420" ([int]$Matches[1] -ge 420) "panelHeight=$($Matches[1]) 太小，面板会显示不全"
  } else {
    Assert "R5.1 面板高度不小于 420" $false "读不到 panelHeight 数值"
  }
}

# ---- R5：新增的两个回传命令（relate_result / relate_saved）----
# 这两个 cmd 由主程序在响应球的「关联知识点」时下发。这里不驱动面板交互
# （面板是独立 Electron 渲染层），而是验证**轮询线程能识别它们、且不会让球崩掉** ——
# 真实存在的缺陷形态是：主程序回传了一条球不认识的 cmd，球侧分支缺失导致抛异常/卡死。
Write-Host "`n[4/6] 测试 relate_result（关联检索回传）" -ForegroundColor Cyan
Send-Ctrl "relate_result" @{
  kw = "摊还分析"; courseId = 1; note = $null
  materials = @(@{ material = "第3讲-摊还分析.txt"; page = 12; snippet = "势能法…" })
  priors = @(@{ id = 1; topic = "摊还分析"; summary = "均摊代价分析" })
  kps = @(@{ id = 1; name = "摊还分析" })
}
Start-Sleep -Seconds 3
$t4 = Get-Content $log -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
Assert "球收到 relate_result 命令" ($t4 -match "收到春晓命令: relate_result") "日志中未见 relate_result 回显"

Write-Host "`n[5/6] 测试 relate_saved（知识点入库回传）" -ForegroundColor Cyan
Send-Ctrl "relate_saved" @{ ok = $true; count = 2; ids = @(11, 12) }
Start-Sleep -Seconds 3
$t5 = Get-Content $log -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
Assert "球收到 relate_saved 命令" ($t5 -match "收到春晓命令: relate_saved") "日志中未见 relate_saved 回显"
Assert "收到两条回传后球仍存活" (-not $proc.HasExited) "球在收到新命令后退出了"

# ---- quit ----
Write-Host "`n[6/6] 测试 quit（应结束进程）" -ForegroundColor Cyan
Send-Ctrl "quit" $null
Start-Sleep -Seconds 4
$exited = $proc.HasExited
Assert "球收到 quit 并退出" $exited "进程仍在运行"

# ---- 兜底清理 ----
if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*$([System.IO.Path]::GetFileName($BallDir))*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue

# ---- 还原悬浮球配置（测试写入的假 Key 不能留在用户环境里）----
if ($BallCfgBackup) {
  [System.IO.File]::WriteAllText($BallCfg, $BallCfgBackup, [System.Text.UTF8Encoding]::new($false))
  Write-Host "（已还原悬浮球配置）" -ForegroundColor DarkGray
} elseif (Test-Path $BallCfg) {
  Remove-Item $BallCfg -Force -ErrorAction SilentlyContinue
  Write-Host "（已移除测试写入的悬浮球配置）" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "--- stderr（应为空或仅警告）---"
$e = Get-Content $err -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
if ($e) { Write-Host $e } else { Write-Host "（空）" }

# 成功时自清临时日志（失败时保留，便于排查）
if ($fail -eq 0) { Remove-Item $log, $err -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host ("桥接冒烟：PASS {0} / FAIL {1}" -f $pass, $fail) -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
exit $(if ($fail -eq 0) { 0 } else { 1 })
