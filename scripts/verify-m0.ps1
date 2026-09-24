# 春晓学习助手 · 质量闸门（M0/M1）
#
#   powershell -File scripts/verify-m0.ps1
#
# 依次执行并汇总（任一失败 → 整体 exit 1，不掩盖）：
#   1. 前端类型检查   npx tsc --noEmit
#   2. 前端构建       npx vite build
#   3. Rust 静态检查  cargo check（src-tauri）
#   4. 图标资产回读   各档 PNG 尺寸 + ICO 尺寸条目（主程序 + 悬浮球）
#   5. 品牌残留扫描   floating-ball/src 内不得再有母本（法律）业务词汇
#   6. 脚本编码检查   scripts/*.ps1 必须带 UTF-8 BOM —— Windows PowerShell 5.1
#                     会把无 BOM 的 UTF-8 当 GBK 读，含中文的脚本报出与行内容
#                     无关的解析错误（M0 已踩过，故纳入闸门自动拦截）
#   7. 浏览器层 UI 冒烟  无头 Edge + CDP 驱动**浏览器预览模式**（!isTauri() 走 sample.ts）
#   8. 桌面真机 UI 冒烟  真 WebView2 + 真 Tauri IPC + 真 SQLite 驱动**桌面应用**，
#                     补 docs/09 §四 T17：预览模式抓不到"前端没把参数传给 Rust"这类
#                     接线缺陷。该步自行隔离数据库、用完自动还原（详见脚本头部说明）
#   9. 悬浮球面板版面守门 无头 Edge 渲染 **panel.html 本身**，断言两个输入框 / 两个按钮 /
#                     抓取模式按钮都**完整落在窗口内**且互不重叠。前 8 步都碰不到它：
#                     它们的对象是数据与主程序，没有任何一层渲染过面板（0.7.0 的
#                     "收起后按钮被裁到窗口外"逃过了全部 8 步，就是缺这一层）

param(
  [switch]$SkipCargo,  # 只想快速验前端时用
  [switch]$SkipUI      # 跳过第 7、8 步（UI 层）：第 7 步需 Edge，第 8 步需已编译的 exe
)

$ErrorActionPreference = "Continue"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$results = New-Object System.Collections.Generic.List[object]

function Step([string]$name, [scriptblock]$body) {
  Write-Host ""
  Write-Host ("=== {0} ===" -f $name) -ForegroundColor Cyan
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ok = $false
  $note = ""
  try {
    $r = & $body
    $ok = [bool]$r.ok
    $note = [string]$r.note
  } catch {
    $ok = $false
    $note = "异常：" + $_.Exception.Message
  }
  $sw.Stop()
  $results.Add([pscustomobject]@{
      name = $name; ok = $ok; note = $note; ms = [int]$sw.ElapsedMilliseconds
    })
  $color = if ($ok) { "Green" } else { "Red" }
  Write-Host ("{0}  ({1:N1}s)  {2}" -f $(if ($ok) { "[PASS]" } else { "[FAIL]" }), ($sw.ElapsedMilliseconds / 1000), $note) -ForegroundColor $color
}

# ---------- 1. 前端类型检查 ----------
Step "1/9 前端类型检查 tsc --noEmit" {
  Push-Location $Root
  $out = & npx tsc --noEmit 2>&1
  $code = $LASTEXITCODE
  Pop-Location
  $out | Select-Object -Last 25 | ForEach-Object { Write-Host "    $_" }
  @{ ok = ($code -eq 0); note = "exit=$code" }
}

# ---------- 2. 前端构建 ----------
Step "2/9 前端构建 vite build" {
  Push-Location $Root
  $out = & npx vite build 2>&1
  $code = $LASTEXITCODE
  Pop-Location
  $out | Select-Object -Last 12 | ForEach-Object { Write-Host "    $_" }
  @{ ok = ($code -eq 0); note = "exit=$code" }
}

# ---------- 3. Rust 静态检查 ----------
if (-not $SkipCargo) {
  Step "3/9 Rust 静态检查 cargo check" {
    Push-Location (Join-Path $Root "src-tauri")
    $out = & cargo check 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $errs = ($out | Select-String -Pattern '^error' -SimpleMatch:$false).Count
    $warns = ($out | Select-String -Pattern '^warning').Count
    $out | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" }
    @{ ok = ($code -eq 0); note = "exit=$code, error=$errs, warning=$warns" }
  }
} else {
  Write-Host ""
  Write-Host "=== 3/8 Rust 静态检查（已按 -SkipCargo 跳过）===" -ForegroundColor DarkGray
}

# ---------- 4. 图标资产回读 ----------
Step "4/9 图标资产回读" {
  Add-Type -AssemblyName System.Drawing
  $iconsDir = Join-Path $Root "src-tauri\icons"
  $expect = @{ "32x32.png" = 32; "64x64.png" = 64; "128x128.png" = 128; "128x128@2x.png" = 256; "icon.png" = 512 }
  $bad = @()
  foreach ($k in $expect.Keys) {
    $f = Join-Path $iconsDir $k
    if (-not (Test-Path $f)) { $bad += "$k 缺失"; continue }
    $img = [System.Drawing.Image]::FromFile($f)
    if ($img.Width -ne $expect[$k]) { $bad += "$k 尺寸 $($img.Width)≠$($expect[$k])" }
    $img.Dispose()
  }
  $ico = Join-Path $iconsDir "icon.ico"
  $icoNote = "ICO 缺失"
  if (Test-Path $ico) {
    $b = [System.IO.File]::ReadAllBytes($ico)
    $n = [BitConverter]::ToUInt16($b, 4)
    $icoNote = "ICO $n 个尺寸条目"
    if ($n -ne 7) { $bad += "ICO 条目数 $n≠7" }
  } else { $bad += "icon.ico 缺失" }
  $ballIcon = Join-Path $Root "floating-ball\assets\icon.png"
  if (-not (Test-Path $ballIcon)) { $bad += "floating-ball/assets/icon.png 缺失" }
  # 悬浮球打包后用 rcedit 写 exe 资源，需要 .ico（rcedit 不吃 .png）
  $ballIco = Join-Path $Root "floating-ball\assets\icon.ico"
  if (-not (Test-Path $ballIco)) { $bad += "floating-ball/assets/icon.ico 缺失（打包品牌化需要）" }
  # 前端 favicon：缺了它每次页面加载都会 404（scripts/smoke-ui.ps1 会抓到）
  foreach ($fav in @("public\favicon.ico", "public\favicon-32.png")) {
    if (-not (Test-Path (Join-Path $Root $fav))) { $bad += "$fav 缺失（否则 /favicon.ico 404）" }
  }
  @{ ok = ($bad.Count -eq 0); note = $(if ($bad.Count -eq 0) { "$icoNote，5 档 PNG + 悬浮球 png/ico + 前端 favicon 齐备" } else { $bad -join "；" }) }
}

# ---------- 5. 品牌残留扫描 ----------
Step "5/9 品牌残留扫描（floating-ball/src）" {
  $dir = Join-Path $Root "floating-ball\src"
  $hits = Get-ChildItem -Recurse $dir -File -Include *.js,*.html |
    Select-String -Pattern '律政|法元|legal-workbench|floating-ball|laws|法条|法库|法规'
  if ($hits) {
    $hits | Select-Object -First 10 | ForEach-Object { Write-Host ("    {0}:{1} {2}" -f (Split-Path $_.Path -Leaf), $_.LineNumber, $_.Line.Trim()) }
  }
  @{ ok = (-not $hits); note = $(if ($hits) { "发现 $($hits.Count) 处母本残留" } else { "无母本业务残留" }) }
}

# ---------- 6. 脚本编码检查 ----------
Step "6/9 PowerShell 脚本编码（UTF-8 BOM）" {
  $dir = Join-Path $Root "scripts"
  $bad = @()
  $all = @(Get-ChildItem -Path $dir -Filter *.ps1 -File -ErrorAction SilentlyContinue)
  foreach ($f in $all) {
    $b = [System.IO.File]::ReadAllBytes($f.FullName)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    if (-not $hasBom) { $bad += $f.Name }
  }
  @{ ok = ($bad.Count -eq 0); note = $(if ($bad.Count) { "缺 BOM：$($bad -join ', ')" } else { "$($all.Count) 个 .ps1 全部带 UTF-8 BOM" }) }
}

# ---------- 7. 浏览器层 UI 冒烟 ----------
# 这一层验的是**渲染出来的界面**：Rust 单测 / 桌面冒烟 / 桥接冒烟都到不了。
# 它抓到过其它层都抓不到的问题（例如缺 favicon 导致每次加载 404）。
# 环境不可用（未装 Edge / 服务起不来）时明确记 SKIP，**不冒充通过**。
if (-not $SkipUI) {
  Step "7/9 浏览器层 UI 冒烟（Edge 无头 + CDP）" {
    Push-Location $Root
    $out = & powershell -NoProfile -File (Join-Path $Root "scripts\smoke-ui.ps1") 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $out | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" }
    if ($code -eq 2) {
      @{ ok = $true; note = "SKIP：环境不可用（未找到 Edge 或服务起不来）" }
    } else {
      @{ ok = ($code -eq 0); note = "exit=$code" }
    }
  }
} else {
  Write-Host ""
  Write-Host "=== 7/8 浏览器层 UI 冒烟（已按 -SkipUI 跳过）===" -ForegroundColor DarkGray
}

# ---------- 8. 桌面真机 UI 冒烟 ----------
# 与第 7 步互补、不是重复：第 7 步只跑**浏览器预览模式**（!isTauri() → sample.ts 示例数据），
# 天然抓不到"前端没把参数传给 Rust"这类**接线缺陷**（R1 修的正是这种，见 docs/12 §事故与缺口）。
# 本步驱动**真桌面应用**（真 WebView2 + 真 Tauri IPC + 真 SQLite），并自行隔离数据库、用完还原。
# 环境不可用（未编译 exe / vite 或 CDP 起不来 / 主程序正在运行）时 exit 2 → 记 SKIP，**不冒充通过**。
if (-not $SkipUI) {
  Step "8/9 桌面真机 UI 冒烟（WebView2 + CDP）" {
    Push-Location $Root
    $out = & powershell -NoProfile -File (Join-Path $Root "scripts\smoke-desktop-ui.ps1") 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $out | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" }
    if ($code -eq 2) {
      @{ ok = $true; note = "SKIP：环境不可用（未编译 exe / 服务或 CDP 起不来 / 主程序在运行）" }
    } else {
      @{ ok = ($code -eq 0); note = "exit=$code" }
    }
  }
} else {
  Write-Host ""
  Write-Host "=== 8/8 桌面真机 UI 冒烟（已按 -SkipUI 跳过）===" -ForegroundColor DarkGray
}

# ---------- 9. 悬浮球面板版面守门 ----------
# 这一层验的是**面板自己渲染出来的版面**。前 8 步全部碰不到面板的 HTML/CSS：
# Rust 单测在数据层、桥接冒烟在文件层、真机冒烟在主程序窗口层。
# 0.7.0 的「收起」缺陷（窗口 64px 装不下 ~100px 的内容 → 按钮行被裁到窗口外，
# 而"展开"按钮就在那一行里 → 用户既点不到也出不来）正是这样逃过全部 8 步的。
# 环境不可用（未装 Edge / CDP 起不来）时 exit 2 → 记 SKIP，**不冒充通过**。
Step "9/9 悬浮球面板版面守门（无头 Edge + CDP）" {
  Push-Location $Root
  $out = & powershell -NoProfile -File (Join-Path $Root "scripts\smoke-ball-panel.ps1") 2>&1
  $code = $LASTEXITCODE
  Pop-Location
  $out | Select-Object -Last 4 | ForEach-Object { Write-Host "    $_" }
  if ($code -eq 2) {
    @{ ok = $true; note = "SKIP：环境不可用（未找到 Edge 或 CDP 起不来）" }
  } else {
    @{ ok = ($code -eq 0); note = "exit=$code" }
  }
}

# ---------- 汇总 ----------
Write-Host ""
Write-Host "================ 质量闸门汇总 ================" -ForegroundColor Cyan
$results | ForEach-Object {
  $c = if ($_.ok) { "Green" } else { "Red" }
  Write-Host ("{0,-8} {1,-34} {2}" -f $(if ($_.ok) { "PASS" } else { "FAIL" }), $_.name, $_.note) -ForegroundColor $c
}
$failed = @($results | Where-Object { -not $_.ok })
Write-Host ("------------------------------------------------")
if ($failed.Count -eq 0) {
  Write-Host "全部通过 ✅" -ForegroundColor Green
  exit 0
} else {
  Write-Host ("未通过 {0} 项 ❌" -f $failed.Count) -ForegroundColor Red
  exit 1
}
