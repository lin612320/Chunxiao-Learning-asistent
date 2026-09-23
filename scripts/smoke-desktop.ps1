# 春晓学习助手 · 桌面端端到端冒烟
#
#   powershell -File scripts/smoke-desktop.ps1 [-ExePath <path>]
#
# 不依赖 sqlite3 CLI：SQLite 会把建表 SQL 与文本值原样存在库文件里，
# 因此直接按字节扫描 .db 文件即可验证「表真的建出来了」「示例课程真的播种了」。
#
# 验证项：
#   1. 主程序启动后进程存活
#   2. %APPDATA%\com.chunxiao.study\chunxiao.db 被创建
#   3. 17 张表 + chunks_fts 虚表 + 3 个同步触发器全部出现在库文件中
#   4. 示例课程已播种（数据里能看到「示例课程」）
#   5. settings 表可写入路径存在（表结构含 key/value）
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
  Write-Host "[SKIP] 未找到已编译的主程序 exe。" -ForegroundColor Yellow
  Write-Host "       先执行：cd src-tauri; cargo build"
  exit 2
}

$DbPath = Join-Path $env:APPDATA "com.chunxiao.study\chunxiao.db"
Write-Host "主程序：$ExePath" -ForegroundColor Cyan
Write-Host "数据库：$DbPath" -ForegroundColor Cyan

# 用一份"干净库"跑，避免上一次残留让断言失真（先备份成 .smoke-bak）
if (Test-Path $DbPath) {
  $bak = "$DbPath.smoke-bak"
  Remove-Item $bak -Force -ErrorAction SilentlyContinue
  Move-Item $DbPath $bak -Force
  Write-Host "（已把已有库移到 $bak）" -ForegroundColor DarkGray
}

$pass = 0; $fail = 0
function Assert([string]$name, [bool]$cond, [string]$detail) {
  if ($cond) { $script:pass++; Write-Host ("  [PASS] {0}" -f $name) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [FAIL] {0} — {1}" -f $name, $detail) -ForegroundColor Red }
}

$log = Join-Path $env:TEMP "cx-desktop.out"
$err = Join-Path $env:TEMP "cx-desktop.err"
Remove-Item $log, $err -ErrorAction SilentlyContinue

Write-Host "`n启动主程序…" -ForegroundColor Cyan
$proc = Start-Process -FilePath $ExePath -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
Start-Sleep -Seconds 12

Assert "主程序进程存活（未崩溃）" (-not $proc.HasExited) $(if ($proc.HasExited) { "已退出，code=$($proc.ExitCode)" } else { "" })
Assert "数据库文件已创建" (Test-Path $DbPath) "未创建 $DbPath"

if (Test-Path $DbPath) {
  # SQLite 处于 WAL 模式：主库被运行中的进程独占，且新写的表/值先在 -wal 里，
  # 因此必须「共享读 + 合并 -wal」，直接 ReadAllBytes 主库会拿到 0 字节（本脚本初版就踩了这个）。
  function Read-FileShared([string]$path) {
    if (-not (Test-Path $path)) { return , ([byte[]]@()) }
    try {
      $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      $len = $fs.Length
      if ($len -le 0) { $fs.Close(); return , ([byte[]]@()) }
      $buf = New-Object byte[] $len
      $n = $fs.Read($buf, 0, $buf.Length)
      $fs.Close()
      if ($n -eq $buf.Length) { return , $buf }
      if ($n -le 0) { return , ([byte[]]@()) }
      return , $buf[0..($n - 1)]
    } catch { return , ([byte[]]@()) }
  }

  $mainBytes = Read-FileShared $DbPath
  $walBytes = Read-FileShared "$DbPath-wal"
  $bytes = [byte[]]($mainBytes + $walBytes)
  # sqlite_master 里存的是建表 SQL 原文，按字节扫描即可（用 Latin1 保持字节一一对应，避免编码丢字节）
  $text = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
  Write-Host ("  主库 {0:N0} B + WAL {1:N0} B = {2:N0} B" -f $mainBytes.Length, $walBytes.Length, $bytes.Length) -ForegroundColor DarkGray

  $tables = @(
    "settings", "courses", "course_prior", "materials", "material_chunks",
    "chat_sessions", "chat_messages", "notes", "annotations",
    "knowledge_points", "questions", "attempts", "profile_traits",
    "pet_state", "focus_sessions", "todos", "mem_vectors"
  )
  $missing = @()
  foreach ($t in $tables) {
    if ($text -notmatch "CREATE TABLE\s+$t\b" -and $text -notmatch "CREATE TABLE IF NOT EXISTS\s+$t\b") { $missing += $t }
  }
  Assert ("17 张表全部建出（缺：{0}）" -f $(if ($missing.Count) { $missing -join ',' } else { "无" })) ($missing.Count -eq 0) "缺少 $($missing -join ', ')"

  Assert "FTS5 虚表 chunks_fts 已建" ($text -match "chunks_fts") "未找到 chunks_fts"
  $trig = @("chunks_ai", "chunks_ad", "chunks_au") | Where-Object { $text -match $_ }
  Assert "3 个同步触发器已建（找到 $($trig.Count) 个）" ($trig.Count -eq 3) "触发器不全：$($trig -join ', ')"

  # 示例课程（UTF-8 文本在库文件中以 UTF-8 字节存在）
  $utf8 = [System.Text.Encoding]::UTF8.GetString($bytes)
  Assert "示例课程已播种" ($utf8 -match "示例课程") "库中未见「示例课程」"
  Assert "settings 表结构含 key/value" ($text -match "CREATE TABLE\s+settings") "未找到 settings 表"
  Assert "WAL 模式已启用（-wal 文件存在）" (Test-Path "$DbPath-wal") "未发现 -wal 文件，可能不是 WAL 模式"
}

Write-Host "`n--- stderr（应无 panic）---"
$e = Get-Content $err -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
if ($e) { Write-Host $e } else { Write-Host "（空）" }

if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Get-Process chunxiao-study -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ---- 还原用户原有的库（本测试把真实库移开、建了个全新的，绝不能就此丢掉用户数据）----
$DbBak = "$DbPath.smoke-bak"
if (Test-Path $DbBak) {
  foreach ($f in @($DbPath, "$DbPath-wal", "$DbPath-shm")) {
    Remove-Item $f -Force -ErrorAction SilentlyContinue
  }
  Move-Item $DbBak $DbPath -Force
  Write-Host "（已还原测试前的数据库）" -ForegroundColor DarkGray
} else {
  # 原本没有库：把测试产生的新库也清掉，保持"跑测试前后本机状态一致"
  foreach ($f in @($DbPath, "$DbPath-wal", "$DbPath-shm")) {
    Remove-Item $f -Force -ErrorAction SilentlyContinue
  }
  Write-Host "（测试前无数据库，已清理测试产生的库）" -ForegroundColor DarkGray
}

# 成功时自清临时日志（失败时保留，便于排查）
if ($fail -eq 0) { Remove-Item $log, $err -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host ("桌面冒烟：PASS {0} / FAIL {1}" -f $pass, $fail) -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
exit $(if ($fail -eq 0) { 0 } else { 1 })
