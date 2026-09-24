# 春晓学习助手 · App 图标生成（由品牌吉祥物母版产出，可复跑）
#
#   powershell -File scripts/make-icons.ps1
#   pwsh      -File scripts/make-icons.ps1
#
# 流水线（4 步）：
#   1. 读唯一母版 `src/assets/mascot.svg`，用 `(?s)<svg[^>]*>(.*)</svg>` 抽出内部内容
#      （含 <defs>：cxSun / cxCloud / cxGlow / cxLeaf / cxSoft 等 id 都在里面）；
#   2. 套进「圆角底盘 + 晨光 + 玻璃高光边」模板，拼出 512×512 的**合成 SVG**
#      写到 $env:TEMP（**不进仓库**），母版内容按 视觉中心(120,120) → 底盘中心(256,256)、scale(2) 注入；
#   3. 用 `scripts/svg-to-png.mjs`（无头 Edge + CDP，零第三方依赖）把**同一份合成 SVG**
#      光栅化到 8 个尺寸：16/24/32/48/64/128/256/512 —— 全部先落到临时目录；
#   4. 光栅化**全部成功后**才写仓库产物（复制 PNG + 拼多尺寸 ICO）——
#      这样「没有 Edge / 光栅化失败」时宁可保留旧图标，也不会留下坏图标。
#
#   圆角半径不是固定像素：底盘 rx=112 是 512 坐标空间的值，8 档都从同一份 SVG 缩放而来，
#   所以小尺寸的圆角自动等比缩小（112/512 = 0.219，16px 档 ≈ 3.5px）。
#
# 产出（路径与文件名被质量闸门第 4 步逐项回读，不要改）：
#   src-tauri/icons/{32x32,64x64,128x128,128x128@2x,icon}.png   （Tauri 打包用）
#   src-tauri/icons/icon.ico                                    （7 尺寸 PNG 条目：16/24/32/48/64/128/256）
#   floating-ball/assets/icon.png                               （256×256，托盘 / BrowserWindow / electron-builder 源图）
#   floating-ball/assets/icon.ico                               （icon.ico 同源副本：rcedit 只吃 .ico）
#   public/favicon.ico / public/favicon-32.png                  （vite 原样拷进 dist；缺了每次加载 404）
#
# 退出码：0 成功 / 2 环境不可用（没装 Edge / 找不到 node / 母版缺失）/ 1 其它失败

param(
  [string]$IconsDir = (Join-Path $PSScriptRoot "..\src-tauri\icons"),
  [string]$BallDir = (Join-Path $PSScriptRoot "..\floating-ball\assets"),
  [string]$Mascot = (Join-Path $PSScriptRoot "..\src\assets\mascot.svg"),
  [string]$Rasterizer = (Join-Path $PSScriptRoot "svg-to-png.mjs"),
  [int]$CdpBase = 9310
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function Fail([string]$msg, [int]$code) {
  Write-Host ""
  Write-Host "[ERROR] $msg" -ForegroundColor Red
  Write-Host "（已保留既有图标产物，未做任何写入）" -ForegroundColor Yellow
  exit $code
}

$IconsDir = [System.IO.Path]::GetFullPath($IconsDir)
$BallDir = [System.IO.Path]::GetFullPath($BallDir)
$Mascot = [System.IO.Path]::GetFullPath($Mascot)
$Rasterizer = [System.IO.Path]::GetFullPath($Rasterizer)
$PublicDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\public"))

# ---- 0. 前置检查（任一不满足 → 报错退出，绝不写仓库）----
if (-not (Test-Path $Mascot)) { Fail "找不到吉祥物母版：$Mascot" 2 }
if (-not (Test-Path $Rasterizer)) { Fail "找不到光栅化器：$Rasterizer" 2 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "未找到 node —— 无法光栅化 SVG" 2 }

# 8 档尺寸：5 档 Tauri PNG ∪ 7 档 ICO（并集，每档只光栅化一次）
$pngTargets = @(
  @{ size = 32;  name = "32x32.png" },
  @{ size = 64;  name = "64x64.png" },
  @{ size = 128; name = "128x128.png" },
  @{ size = 256; name = "128x128@2x.png" },
  @{ size = 512; name = "icon.png" }
)
$icoSizes = @(16, 24, 32, 48, 64, 128, 256)
$rasterSizes = @($icoSizes + @($pngTargets | ForEach-Object { $_.size }) | Sort-Object -Unique)

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("cx-icons-" + [guid]::NewGuid().ToString("N"))
$pngDir = Join-Path $work "png"
$compositeSvg = Join-Path $work "tile.svg"

try {
  New-Item -ItemType Directory -Force -Path $pngDir | Out-Null

  # ---- 1. 抽取母版内部内容 ----
  $mascotText = [System.IO.File]::ReadAllText($Mascot)
  $m = [regex]::Match($mascotText, '(?s)<svg[^>]*>(.*)</svg>')
  if (-not $m.Success) { Fail "无法从母版中抽出 <svg> 内部内容：$Mascot" 2 }
  $inner = $m.Groups[1].Value.Trim()
  Write-Host ("母版：{0}  →  内部内容 {1:N0} 字符（含 <defs> 渐变/滤镜 id）" -f (Split-Path $Mascot -Leaf), $inner.Length)

  # ---- 2. 合成 SVG：圆角底盘 + 顶光 + 玻璃质感 + 母版内容（R10：盘色/光色换成 DSH 令牌）----
  #   母版是**透明底角色**，直接当图标会糊在任务栏上；先合成到圆角底盘上。
#   R10：底盘用 DSH 的近黑（layer-2 #2C2C2E → brand-primary #0F1115），
#   顶光用 DSH 品牌蓝 #5686FE —— 于是**蓝色鲸鱼在近黑盘上**，与主题同源。
  #   取景：视觉中心 (120,120) 对齐底盘中心 (256,256)，scale(2) → 内容约占底盘 70%，四边留白均匀。
  $composite = @"
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2C2C2E"/>
      <stop offset="1" stop-color="#0F1115"/>
    </linearGradient>
    <radialGradient id="dawn" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#5686FE" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#5686FE" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/>
      <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <!-- 圆角底盘 -->
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#tile)"/>
  <!-- 顶部顶光：DSH 品牌蓝的一抹，给底盘一点方向感 -->
  <ellipse cx="256" cy="150" rx="228" ry="130" fill="url(#dawn)"/>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#glass)"/>
  <!-- 玻璃质感内描边（"高级"的关键：一圈极细的高光边） -->
  <rect x="3" y="3" width="506" height="506" rx="109" fill="none" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="2"/>
  <!-- 吉祥物：视觉中心 (120,120) → 底盘中心 (256,256)，缩放 2 倍 -->
  <g transform="translate(256 256) scale(2) translate(-120 -120)">
$inner
  </g>
</svg>
"@
  # 临时文件不带 BOM：光栅化器按 utf8 读，BOM 会变成注入 HTML 里的零宽字符
  [System.IO.File]::WriteAllText($compositeSvg, $composite, (New-Object System.Text.UTF8Encoding($false)))

  # ---- 3. 光栅化（全部先落到临时目录；任一失败即中止，不动仓库产物）----
  Write-Host "光栅化合成 SVG（无头 Edge + CDP）："
  for ($i = 0; $i -lt $rasterSizes.Count; $i++) {
    $size = $rasterSizes[$i]
    $outPng = Join-Path $pngDir "$size.png"
    # ⚠ 连续调用换端口：上一个 Edge 实例可能还没释放端口
    $cdp = $CdpBase + $i
    & node $Rasterizer --svg $compositeSvg --out $outPng --size $size --cdp $cdp
    $code = $LASTEXITCODE
    if ($code -eq 2) { Fail "光栅化环境不可用（exit 2，${size}px）—— 请确认已安装 Microsoft Edge" 2 }
    if ($code -ne 0) { Fail "光栅化失败（exit $code，${size}px）" 1 }
    if (-not (Test-Path $outPng)) { Fail "光栅化未产出文件（${size}px）" 1 }
  }

  # ---- 4. 写入仓库产物（到这里为止所有档位都已光栅化成功）----
  foreach ($d in @($IconsDir, $BallDir, $PublicDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  }
  foreach ($t in $pngTargets) {
    Copy-Item (Join-Path $pngDir "$($t.size).png") (Join-Path $IconsDir $t.name) -Force
  }

  # ---- 4.1 多尺寸 ICO（PNG 压缩条目）----
  #   条目字节直接取光栅化出来的 PNG 文件；ICO 结构仍是手写 ICONDIR / ICONDIRENTRY
  $blobs = @()
  foreach ($s in $icoSizes) {
    $blobs += [pscustomobject]@{ size = $s; bytes = [System.IO.File]::ReadAllBytes((Join-Path $pngDir "$s.png")) }
  }

  $out = New-Object System.Collections.Generic.List[byte]
  $count = [byte]$blobs.Count
  $offset = 6 + 16 * $blobs.Count
  # ICONDIR
  $out.AddRange([byte[]]@([byte]0, [byte]0, [byte]1, [byte]0, $count, [byte]0))
  foreach ($b in $blobs) {
    $dim = if ($b.size -ge 256) { [byte]0 } else { [byte]$b.size }
    # width, height, colorCount, reserved, planes(1), bitCount(32)
    $out.AddRange([byte[]]@($dim, $dim, [byte]0, [byte]0, [byte]1, [byte]0, [byte]32, [byte]0))
    $out.AddRange([BitConverter]::GetBytes([int]$b.bytes.Length))
    $out.AddRange([BitConverter]::GetBytes([int]$offset))
    $offset += $b.bytes.Length
  }
  foreach ($b in $blobs) { $out.AddRange($b.bytes) }
  $icoPath = Join-Path $IconsDir "icon.ico"
  [System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())

  # ---- 4.2 悬浮球图标 ----
  #   icon.png → Electron 托盘 / BrowserWindow 图标 / electron-builder 打包源图
  #   icon.ico → 打包后由 floating-ball/scripts/after-pack.js 调 rcedit 写入 exe 资源
  #              （exe 图标只吃 .ico，不吃 .png）
  Copy-Item (Join-Path $pngDir "256.png") (Join-Path $BallDir "icon.png") -Force
  Copy-Item $icoPath (Join-Path $BallDir "icon.ico") -Force

  # ---- 4.3 前端 favicon ----
  #   浏览器默认请求 /favicon.ico；缺了它**每次加载都会 404**，标签页也没有品牌标。
  #   vite 会把 `public/` 原样拷进 `dist/`，所以放这里即可。
  Copy-Item $icoPath (Join-Path $PublicDir "favicon.ico") -Force
  Copy-Item (Join-Path $IconsDir "32x32.png") (Join-Path $PublicDir "favicon-32.png") -Force
} finally {
  if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---- 5. 回读校验 ----
$ico = [System.IO.File]::ReadAllBytes($icoPath)
$icoCount = [BitConverter]::ToUInt16($ico, 4)
$entries = @()
for ($i = 0; $i -lt $icoCount; $i++) {
  $base = 6 + 16 * $i
  $w = $ico[$base]; if ($w -eq 0) { $w = 256 }
  $len = [BitConverter]::ToInt32($ico, $base + 8)
  $off = [BitConverter]::ToInt32($ico, $base + 12)
  $isPng = ($ico[$off] -eq 0x89 -and $ico[$off + 1] -eq 0x50)
  $entries += [pscustomobject]@{ size = $w; bytes = $len; png = $isPng }
}
Write-Host "生成完成：" -ForegroundColor Green
foreach ($t in $pngTargets) {
  $f = Join-Path $IconsDir $t.name
  $bmp = [System.Drawing.Image]::FromFile($f)
  Write-Host ("  {0,-14} {1,4}x{2,-4} {3,7:N0} B" -f $t.name, $bmp.Width, $bmp.Height, (Get-Item $f).Length)
  $bmp.Dispose()
}
Write-Host ("  icon.ico       {0} 个尺寸条目：{1}" -f $icoCount, (($entries | ForEach-Object { "{0}px{1}" -f $_.size, $(if ($_.png) { "" } else { "(非PNG!)" }) }) -join " / "))
Write-Host ("  floating-ball/assets/icon.png  256x256  {0,7:N0} B" -f (Get-Item (Join-Path $BallDir "icon.png")).Length)

# 透明角：圆角外必须完全透明（否则任务栏/托盘上会看到一块方形底）
$corner = New-Object System.Drawing.Bitmap((Join-Path $IconsDir "icon.png"))
$cornerAlpha = $corner.GetPixel(0, 0).A
$corner.Dispose()
Write-Host ("  icon.png (512) 角落 (0,0) alpha = {0}" -f $cornerAlpha)

if ($entries | Where-Object { -not $_.png }) { Write-Warning "ICO 中存在非 PNG 条目！" }
if ($icoCount -ne 7) { Write-Warning "ICO 尺寸条目数不是 7！" }
if ($cornerAlpha -ne 0) { Write-Warning "icon.png 圆角外不透明（角落 alpha = $cornerAlpha）！" }
