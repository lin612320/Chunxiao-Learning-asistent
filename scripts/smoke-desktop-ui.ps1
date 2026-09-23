# 春晓学习助手 · 桌面**真机** UI 冒烟（隔离数据库 → 起 vite → 起主程序 → CDP 驱动 WebView2 → 还原 → 收尾）
#
#   powershell -File scripts/smoke-desktop-ui.ps1
#
# 与另两层的分工：
#   · scripts/smoke-ui.ps1       —— 浏览器**预览模式**（`!isTauri()` 走 sample.ts 示例数据）
#   · scripts/smoke-desktop.ps1  —— 只验"进程起得来 + 表建出来了"（按字节扫描库文件，**驱动不了界面**）
#   · **本脚本**                 —— 真 WebView2 + 真 Tauri IPC + 真 SQLite，**真的驱动界面**
#     补的是 docs/09 §四 **T17** 的核心缺口：预览模式天然抓不到"前端没把参数传给 Rust"
#     这类**接线缺陷**（R1 修的正是这种：`useChat` 从没拿到 `courseId`，而 sample.ts 的
#     预览会话恰好带了 course_id → 预览全绿、桌面全死）。
#
# 手法：给 WebView2 传 `--remote-debugging-port`（环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS），
#      再用与 smoke-ui 相同的 CDP 手法驱动**真实桌面应用**。
#
# ⚠⚠ 数据安全（**这里踩过真实事故，别再改回去**）：
#   曾经用"把子进程的 `APPDATA` 指向临时目录"来隔离数据库 —— **那是错的**：Windows 的
#   known-folder API 不读 `%APPDATA%` 环境变量，主程序照样打开**用户的真实库**，
#   结果测试把数据写进了真实库（还触发了一次真实的模型 API 调用）。详见 docs/12 的事故记录。
#   现在改为**移开真实库（*.smoke-bak）+ 用完还原**，与 smoke-desktop.ps1 同一套做法：
#   不依赖任何环境变量假设，路径相同就一定能隔离。
#   另外：主程序在跑时**拒绝执行**（库文件正被占用，强移有风险）。
#
# ⚠ debug 版主程序从 `devUrl`（http://localhost:1420）加载前端，因此**需要 vite 在跑**（本脚本会起）。
#   若只想用已打包前端，请显式传 release exe：-ExePath src-tauri\target\release\chunxiao-study.exe
#
# 退出码：0 全过 / 1 有断言失败 / 2 环境不可用（exe、vite、CDP，或检测到主程序在运行）

param(
  [int]$VitePort = 1420,
  [int]$CdpPort = 9224,
  [string]$ExePath = ""
)

$ErrorActionPreference = "Continue"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Base = "http://localhost:$VitePort"
$Cdp = "http://127.0.0.1:$CdpPort"
$DbDir = Join-Path $env:APPDATA "com.chunxiao.study"
$DbPath = Join-Path $DbDir "chunxiao.db"
$DbBak = "$DbPath.smoke-bak"

function Test-Http([string]$url) {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3; return $r.StatusCode -eq 200 } catch { return $false }
}

$viteJob = $null
$app = $null
$hadDb = $false
$code = 2

function Restore-UserDb {
  # 先确保主程序真的退出了，否则库文件句柄没释放，还原会失败
  Get-Process chunxiao-study -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  for ($i = 0; $i -lt 3; $i++) {
    foreach ($ext in @("", "-wal", "-shm")) {
      Remove-Item "$DbPath$ext" -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $DbPath)) { break }
    Start-Sleep -Milliseconds 700
  }
  if ($hadDb) {
    foreach ($ext in @("", "-wal", "-shm")) {
      if (Test-Path "$DbBak$ext") { Move-Item "$DbBak$ext" "$DbPath$ext" -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path $DbPath) {
      Write-Host "（已还原测试前的真实数据库）" -ForegroundColor DarkGray
    } else {
      Write-Host "（⚠ 未能还原真实数据库！备份仍在：$DbBak）" -ForegroundColor Red
    }
  } else {
    Write-Host "（测试前无数据库，已清理测试产生的库）" -ForegroundColor DarkGray
  }
}

# ---------- 1. 找主程序 exe ----------
if (-not $ExePath) {
  $candidates = @(
    (Join-Path $Root "src-tauri\target\debug\chunxiao-study.exe"),
    (Join-Path $Root "src-tauri\target\release\chunxiao-study.exe")
  )
  $ExePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ExePath -or -not (Test-Path $ExePath)) {
  Write-Host "[SKIP] 未找到已编译的主程序 exe。" -ForegroundColor Yellow
  Write-Host "       先执行：cd src-tauri; cargo build"
  exit 2
}
Write-Host "主程序：$ExePath" -ForegroundColor Cyan

# ---------- 2. 数据库隔离（关键，见文件头的事故说明）----------
if (Get-Process chunxiao-study -ErrorAction SilentlyContinue) {
  Write-Host "[SKIP] 检测到主程序正在运行 —— 库文件正被占用，本脚本不会强移你的数据库。" -ForegroundColor Yellow
  Write-Host "       请先关闭春晓主程序，再重跑本脚本。"
  exit 2
}
$hadDb = Test-Path $DbPath
if ($hadDb) {
  foreach ($ext in @("", "-wal", "-shm")) { Remove-Item "$DbBak$ext" -Force -ErrorAction SilentlyContinue }
  foreach ($ext in @("", "-wal", "-shm")) {
    if (Test-Path "$DbPath$ext") { Move-Item "$DbPath$ext" "$DbBak$ext" -Force }
  }
  Write-Host "（已把真实数据库移开为 *.smoke-bak；测试结束后自动还原）" -ForegroundColor DarkGray
} else {
  Write-Host "（本机原本没有数据库；测试产生的库会在结束后清理）" -ForegroundColor DarkGray
}

try {
  # ---------- 3. vite（debug 版主程序从 devUrl 加载前端）----------
  if (-not (Test-Http $Base)) {
    Write-Host "应用服务不可达，正在启动 vite（npm run dev）…" -ForegroundColor Cyan
    $viteLog = Join-Path $env:TEMP "cx-desktop-ui-vite.log"
    $viteJob = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev > `"$viteLog`" 2>&1" `
      -WorkingDirectory $Root -PassThru -WindowStyle Hidden
    # 超时放宽到 150s：与 smoke-ui.ps1 同因（并行跑 tsc / vite build 时启动会被饿慢）
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline -and -not (Test-Http $Base)) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Http $Base)) {
      Write-Host "[失败] vite 未在 150s 内就绪，日志：$viteLog" -ForegroundColor Red
      Get-Content $viteLog -ErrorAction SilentlyContinue | Select-Object -Last 15
      throw "vite 未就绪"
    }
  }
  Write-Host "应用服务就绪：$Base" -ForegroundColor Green

  # ---------- 4. 起主程序（开 WebView2 远程调试）----------
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
  $appLog = Join-Path $env:TEMP "cx-desktop-ui-app.log"
  Remove-Item $appLog -ErrorAction SilentlyContinue

  Write-Host "启动主程序（真机模式，用的是隔离空库）…" -ForegroundColor Cyan
  # ⚠ 不要 -WindowStyle Hidden：WebView2 在隐藏窗口下可能不渲染，CDP 连上了也拿不到绘制结果
  $app = Start-Process -FilePath $ExePath -PassThru -RedirectStandardError $appLog

  $deadline = (Get-Date).AddSeconds(60)
  $cdpReady = $false
  while ((Get-Date) -lt $deadline) {
    if ($app.HasExited) { break }
    try {
      $null = Invoke-WebRequest -Uri "$Cdp/json/version" -UseBasicParsing -TimeoutSec 2
      $cdpReady = $true
      break
    } catch { Start-Sleep -Milliseconds 500 }
  }

  if ($cdpReady) {
    Write-Host "CDP 就绪，开始驱动真桌面应用`n" -ForegroundColor Green
    $env:CDP_ENDPOINT = $Cdp
    Push-Location $Root
    & node "scripts/smoke-desktop-ui.mjs"
    $code = $LASTEXITCODE
    Pop-Location
  } else {
    Write-Host "[失败] 主程序 CDP 端点未就绪（$Cdp）" -ForegroundColor Red
    if ($app.HasExited) { Write-Host "       主程序已退出，code=$($app.ExitCode)" -ForegroundColor Red }
    Get-Content $appLog -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 20
    $code = 2
  }
} catch {
  if ($null -eq $code -or $code -eq 0) { $code = 2 }
  Write-Host "（收尾：$($_.Exception.Message)）" -ForegroundColor DarkYellow
} finally {
  # ---------- 5. 收尾（务必还原真实库）----------
  if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
  if ($viteJob -and -not $viteJob.HasExited) {
    Write-Host "（关闭本脚本启动的 vite）" -ForegroundColor DarkGray
    Stop-Process -Id $viteJob.Id -Force -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'vite' -and $_.CommandLine.Contains($Root) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue

  # 失败时先把测试库留一份到 %TEMP% 供排查（不留在用户的数据目录里）
  if ($code -ne 0 -and (Test-Path $DbPath)) {
    $keep = Join-Path $env:TEMP "cx-desktop-ui-failed.db"
    Copy-Item $DbPath $keep -Force -ErrorAction SilentlyContinue
    Write-Host "（失败排查副本：$keep）" -ForegroundColor DarkYellow
  }
  Restore-UserDb

  if ($code -eq 0) { Remove-Item (Join-Path $env:TEMP "cx-desktop-ui-app.log") -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host ("桌面真机 UI 冒烟退出码：{0}" -f $code) -ForegroundColor $(if ($code -eq 0) { "Green" } else { "Red" })
exit $code
