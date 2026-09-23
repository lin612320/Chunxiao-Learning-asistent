# 春晓学习助手 · 材料检索桥接闭环冒烟
#
#   powershell -File scripts/smoke-material-chain.ps1
#
# 验证「悬浮球 → 主程序检索 → 回传结果」这条链路。用文件协议验证，
# 不需要 GUI 交互、不需要模型 Key、不需要库里有材料。
#
# 覆盖两轮：
#   第 1 轮 单关键词（"梯度下降"）
#   第 2 轮 含标点的长选段（"极限，导数；连续"）—— 真实覆盖 `pick_keyword` 的切段路径：
#          球推来带标点的长选段时，抽词后链路仍正常且标点不会漏进查询词。
#          （多词 OR 召回只从对话页进入，不在本脚本覆盖范围内 → 由 Rust 单测覆盖）
#
# ⚠ 本脚本只验证**链路管道**（含空命中也是合法结果）。
#   "命中真实关键词"与"多词 OR 召回正确性"由 Rust 单测
#   material_search_fts_hits_and_ranks / material_search_multi_keyword_or_recall 覆盖。

param(
  [string]$ExePath = ""
)

$ErrorActionPreference = "Continue"
$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

if (-not $ExePath) {
  $candidates = @(
    (Join-Path $Root "src-tauri\target\debug\chunxiao-study.exe"),
    (Join-Path $Root "src-tauri\target\release\chunxiao-study.exe")
  )
  $ExePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ExePath -or -not (Test-Path $ExePath)) {
  Write-Host "[SKIP] 未找到已编译的主程序 exe。先执行：cd src-tauri; cargo build" -ForegroundColor Yellow
  exit 2
}

$BridgeDir = Join-Path $env:APPDATA "chunxiao-ball"
$FromBall = Join-Path $BridgeDir "from-ball.json"
$ToBall = Join-Path $BridgeDir "to-ball.json"
if (-not (Test-Path $BridgeDir)) { New-Item -ItemType Directory -Force -Path $BridgeDir | Out-Null }

# 备份并清掉两侧文件，避免上一次残留让断言失真
$bakFrom = if (Test-Path $FromBall) { Get-Content $FromBall -Raw -Encoding UTF8 } else { $null }
$bakTo = if (Test-Path $ToBall) { Get-Content $ToBall -Raw -Encoding UTF8 } else { $null }
Remove-Item $FromBall, $ToBall -Force -ErrorAction SilentlyContinue

$pass = 0; $fail = 0
function Assert([string]$name, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host ("  [PASS] {0}" -f $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [FAIL] {0} — {1}" -f $name, $detail) -ForegroundColor Red }
}

# 走一轮完整往返：写请求 → 轮询等待回传 → 返回解析结果（超时返回 $null）
function Invoke-RoundTrip([string]$text) {
  $payload = @{
    ts     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    text   = $text
    action = "material_search"
  } | ConvertTo-Json -Compress
  Write-Host ("  → 写入 from-ball.json: {0}" -f $payload) -ForegroundColor DarkGray
  [System.IO.File]::WriteAllText($FromBall, $payload, [System.Text.UTF8Encoding]::new($false))

  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $ToBall) {
      $raw = Get-Content $ToBall -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($raw -and $raw.Trim()) {
        try {
          $r = $raw | ConvertFrom-Json
          if ($r) {
            Remove-Item $ToBall -Force -ErrorAction SilentlyContinue
            return $r
          }
        } catch { }
      }
    }
  }
  return $null
}

$log = Join-Path $env:TEMP "cx-material-chain.out"
$err = Join-Path $env:TEMP "cx-material-chain.err"
Remove-Item $log, $err -ErrorAction SilentlyContinue

Write-Host "主程序：$ExePath" -ForegroundColor Cyan
Write-Host "启动主程序（等待桥接轮询线程起来）…" -ForegroundColor Cyan
$proc = Start-Process -FilePath $ExePath -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
Start-Sleep -Seconds 10
Assert "主程序进程存活" (-not $proc.HasExited) "进程已退出"

# ---- 第 1 轮：单关键词 ----
Write-Host "`n[1/2] 单关键词检索（M1 既有路径）" -ForegroundColor Cyan
$r1 = Invoke-RoundTrip "梯度下降"
Assert "第 1 轮回传到达" ($null -ne $r1) "20s 内未收到回传"
if ($r1) {
  Write-Host ("  ← {0}" -f ($r1 | ConvertTo-Json -Depth 4 -Compress)) -ForegroundColor DarkGray
  Assert "cmd 为 material_result" ($r1.cmd -eq "material_result") "实际 cmd=$($r1.cmd)"
  Assert "kw 非空" ([bool]$r1.kw) "kw 为空"
  Assert "results 是数组" ($r1.results -is [array] -or $null -eq $r1.results) "results 类型异常"
}

# ---- 第 2 轮：含标点的长选段（真实覆盖 pick_keyword 的切段路径）----
# 注意：桥接路径会先经 pick_keyword 抽词，所以**在桥上发多段文字不会触发多词 OR**
#（多词 OR 只从对话页进入，由 Rust 单测覆盖）。这一轮真正验证的是：
# 球推来一段带标点的长选段时，抽词后链路仍正常，且**标点不会漏进查询词**。
Write-Host "`n[2/2] 含标点长选段检索（覆盖 pick_keyword 切段）" -ForegroundColor Cyan
$seg1 = "极限"
$seg2 = "导数"
$multi = "$seg1，$seg2；连续"
$r2 = Invoke-RoundTrip $multi
Assert "第 2 轮回传到达（长选段不炸链路）" ($null -ne $r2) "20s 内未收到回传——抽词或检索路径可能报错"
if ($r2) {
  Write-Host ("  ← {0}" -f ($r2 | ConvertTo-Json -Depth 4 -Compress)) -ForegroundColor DarkGray
  Assert "cmd 仍为 material_result" ($r2.cmd -eq "material_result") "实际 cmd=$($r2.cmd)"
  Assert "查询词非空" ([bool]$r2.kw) "kw 为空"
  Assert "查询词不含标点（切段生效）" (-not ($r2.kw -match '[，；。、,;]')) "kw='$($r2.kw)' 里漏进了标点——pick_keyword 切段失效"
  Assert "查询词是原文片段" ($multi.Contains($r2.kw)) "kw='$($r2.kw)' 不是原文的子串"
}

# ---- 链路管道收尾断言 ----
Assert "from-ball.json 已被消费删除" (-not (Test-Path $FromBall)) "请求文件仍在（未被消费）"

# ---- 清理与还原 ----
Remove-Item $ToBall -Force -ErrorAction SilentlyContinue
if ($bakFrom) { [System.IO.File]::WriteAllText($FromBall, $bakFrom, [System.Text.UTF8Encoding]::new($false)) }
if ($bakTo) { [System.IO.File]::WriteAllText($ToBall, $bakTo, [System.Text.UTF8Encoding]::new($false)) }

if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Get-Process chunxiao-study -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "`n--- stderr（应无 panic）---"
$e = Get-Content $err -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
if ($e) { Write-Host $e } else { Write-Host "（空）" }

# 成功时自清临时日志（失败时保留，便于排查）
if ($fail -eq 0) { Remove-Item $log, $err -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host ("材料检索链冒烟：PASS {0} / FAIL {1}" -f $pass, $fail) -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
exit $(if ($fail -eq 0) { 0 } else { 1 })
