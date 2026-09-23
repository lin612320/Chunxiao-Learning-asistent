# 春晓学习助手 · 浏览器层 UI 冒烟（一键：起服务 → 起无头 Edge → 跑断言 → 收尾）
#
#   powershell -File scripts/smoke-ui.ps1
#
# 为什么需要这一层：Rust 单测 / 桌面冒烟 / 桥接冒烟都验证不到**渲染出来的界面**。
# 本脚本用真实 Chromium 内核（Edge 无头 + CDP）加载预览版页面，断言 DOM 真的渲染出预期元素，
# 并收集 console 报错与失败请求。断言逻辑在 scripts/smoke-ui.mjs（无第三方依赖）。
#
# ⚠ 覆盖范围：**浏览器预览模式**（!isTauri() 走 sample.ts 示例数据）的 UI 与降级路径。
#   桌面 SQLite 链路由 scripts/smoke-desktop.ps1 与 cargo test --lib 覆盖，不在本脚本内。
#
# 退出码：0 全过 / 1 有断言失败 / 2 环境不可用（服务或浏览器起不来）

param(
  [int]$Port = 1420,
  [int]$CdpPort = 9222,
  [switch]$KeepBrowser   # 排障用：跑完不关浏览器
)

$ErrorActionPreference = "Continue"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Base = "http://localhost:$Port"
$Cdp = "http://127.0.0.1:$CdpPort"

function Test-Http([string]$url) {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3; return $r.StatusCode -eq 200 } catch { return $false }
}

# ---------- 1. 应用服务 ----------
$viteJob = $null
# ⚠ 必须先初始化：若本机已有 vite 在 1420 上跑（例如你手动开着 npm run dev），
#   下面不会启动新服务、也就不会给 $viteLog 赋值；而收尾段的 Test-Path $viteLog
#   会因参数为 $null 抛 ParameterArgumentValidationError（只是噪音，但很难看）。
$viteLog = $null
if (-not (Test-Http $Base)) {
  Write-Host "应用服务不可达，正在启动 vite（npm run dev）…" -ForegroundColor Cyan
  $viteLog = Join-Path $env:TEMP "cx-ui-vite.log"
  $viteJob = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev > `"$viteLog`" 2>&1" `
    -WorkingDirectory $Root -PassThru -WindowStyle Hidden
  # ⚠ 超时要放宽：若同时有代理在跑 tsc / vite build，npm→vite 的启动会被饿慢；
  #   本机实测曾"60s 未就绪"而 vite 其实只差几秒（日志显示 ready in 1456ms）。
  $deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $deadline -and -not (Test-Http $Base)) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Http $Base)) {
    Write-Host "[失败] vite 未在 150s 内就绪，日志：$viteLog" -ForegroundColor Red
    # ⚠ 失败路径也必须**回收自己起的进程链**：否则留下孤儿 vite 占着 1420，
    #   下一次运行会误判"服务不可达"再去起第二个（本机真实踩过）。
    if ($viteJob -and -not $viteJob.HasExited) { Stop-Process -Id $viteJob.Id -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'vite' -and $_.CommandLine.Contains($Root) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    exit 2
  }
}
Write-Host "应用服务就绪：$Base" -ForegroundColor Green

# ---------- 2. 无头 Edge + CDP ----------
$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
  Write-Host "[失败] 未找到 msedge.exe（本脚本依赖 Edge 的 Chromium 内核）" -ForegroundColor Red
  exit 2
}

$profile = Join-Path $env:TEMP ("cx-ui-profile-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$edgeLog = Join-Path $env:TEMP "cx-ui-edge.log"
Remove-Item $edgeLog -ErrorAction SilentlyContinue

Write-Host "启动无头 Edge（CDP $cdp，独立临时 profile）…" -ForegroundColor Cyan
$edgeArgs = @(
  "--headless=new",
  "--remote-debugging-port=$CdpPort",
  "--user-data-dir=$profile",
  "--window-size=1440,900",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-extensions",
  "about:blank"
)
$edgeProc = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru -WindowStyle Hidden `
  -RedirectStandardError $edgeLog

$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
  try {
    $null = Invoke-WebRequest -Uri "$Cdp/json/version" -UseBasicParsing -TimeoutSec 2
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
$cdpReady = $false
try { $null = Invoke-WebRequest -Uri "$Cdp/json/version" -UseBasicParsing -TimeoutSec 2; $cdpReady = $true } catch { }

if (-not $cdpReady) {
  Write-Host "[失败] CDP 端点未就绪（$Cdp）" -ForegroundColor Red
  Get-Content $edgeLog -ErrorAction SilentlyContinue | Select-Object -First 10
} else {
  Write-Host "CDP 就绪，开始断言`n" -ForegroundColor Green
}

# ---------- 3. 跑断言 ----------
$code = 2
if ($cdpReady) {
  $env:CDP_ENDPOINT = $Cdp
  $env:APP_URL = $Base
  Push-Location $Root
  & node "scripts/smoke-ui.mjs"
  $code = $LASTEXITCODE
  Pop-Location
}

# ---------- 4. 收尾 ----------
if (-not $KeepBrowser) {
  # Edge 会拉起多个子进程：按临时 profile 的命令行匹配清理，比只杀主进程可靠
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  # Edge 退出后文件句柄可能还没释放，删不掉就重试几次；
  # 否则会在 %TEMP% 下堆一堆 profile 目录（本脚本初版就留下过 10 个）
  for ($i = 0; $i -lt 3; $i++) {
    Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $profile)) { break }
    Start-Sleep -Milliseconds 600
  }
  if (Test-Path $profile) {
    Write-Host "（提示：临时 profile 未完全删除，可手动清理：$profile）" -ForegroundColor DarkYellow
  }
  if ($viteJob -and -not $viteJob.HasExited) {
    Write-Host "（关闭本脚本启动的 vite）" -ForegroundColor DarkGray
    Stop-Process -Id $viteJob.Id -Force -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'vite' -and $_.CommandLine.Contains($Root) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}

# 成功时自清临时日志（失败时保留，便于排查）。
# ⚠ vite 是经 `cmd /c ... > log` 重定向起的：杀掉进程后**文件句柄释放有延迟**，
#   一次删除会被静默跳过（-ErrorAction SilentlyContinue）→ 必须重试，
#   否则 %TEMP% 里会一直留一个 cx-ui-vite.log。
if ($code -eq 0) {
  $logs = @($edgeLog, $viteLog) | Where-Object { $_ }
  for ($i = 0; $i -lt 4; $i++) {
    Remove-Item $logs -Force -ErrorAction SilentlyContinue
    if (-not (@($logs) | Where-Object { Test-Path $_ })) { break }
    Start-Sleep -Milliseconds 400
  }
}

Write-Host ""
Write-Host ("UI 冒烟退出码：{0}" -f $code) -ForegroundColor $(if ($code -eq 0) { "Green" } else { "Red" })
exit $code
