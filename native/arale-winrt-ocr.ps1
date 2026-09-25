<#
.SYNOPSIS
  arale-winrt-ocr —— 用 Windows.Media.Ocr 做 OCR，输出与应用约定的 NDJSON。

.DESCRIPTION
  与 macOS 的 `arale-vision-ocr`（Swift）**说同一种协议**（src/shared/ocr-protocol.ts）：

    {"kind":"meta","engine":"winrt-ocr","languages":["ja-JP"],"requested":["ja-JP"]}
    {"kind":"page","file":"…","ok":true,"width":W,"height":H,"lines":[{…}]}
    {"kind":"page","file":"…","ok":false,"error":"…"}
    {"kind":"fatal","error":"…"}
    {"kind":"probe","ok":true|false,"error":"…"}

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File arale-winrt-ocr.ps1 -- <图片> [...]
    powershell -NoProfile -ExecutionPolicy Bypass -File arale-winrt-ocr.ps1 --probe

  ⚠️ **本文件在 macOS 上没有也无法被构建/验证。** Windows 的 OCR 只能用
  Windows.Media.Ocr 这个 WinRT API，而本机是 macOS。这里实现的是「协议 + 调用方式」，
  真正跑起来需要在 Windows 上实测一次（包括中日文语言包的可用性）。第一次在
  Windows 上跑请先执行 `--probe`，它会明确告诉你语言包在不在。

.NOTES
  为什么用 PowerShell 而不是编一个 C# 小工具：
    - 不需要用户装 .NET SDK，也不需要为每个架构单独出版本；
    - WinRT 类型可以直接从 PowerShell 里加载（`[Windows.Media.Ocr.OcrEngine, …,
      ContentType=WindowsRuntime]`）；
    - 代码量小到可以完整读懂，而 OCR 是条长链路，可读性比性能重要。
  代价是启动比原生二进制慢（几百毫秒），对一本几百页的任务完全可以忽略。
#>

[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# stdout 必须**只有** NDJSON：先把它按 UTF-8 定死，避免 PowerShell 默认按控制台代码页
# 编码，把日文写成一串问号。写一行 flush 一行，主进程才能边收边报进度。
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

function Emit-Json($Object) {
  $stdout.WriteLine(($Object | ConvertTo-Json -Compress -Depth 8))
}

function Fail($Message, $Code) {
  Emit-Json @{ kind = 'fatal'; error = $Message }
  $stdout.Flush()
  exit $Code
}

# WinRT 的异步方法（IAsyncOperation）在 PowerShell 里不能直接 await，
# 需要把它转成 .NET Task 再 Wait。这是用 PowerShell 调 WinRT 的标准套路。
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# 加载 WinRT 类型。少了这一步后面每个类型名都会报「找不到类型」。
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

function New-OcrEngine {
  param([string[]]$Languages)

  # 只挑系统**真的装了**的语言包：`TryCreateFromLanguage` 对没装的语言返回 null，
  # 不判断就会静默退回默认引擎然后识别出一堆乱码。
  $available = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
  $availableTags = @($available | ForEach-Object { $_.LanguageTag })

  foreach ($tag in $Languages) {
    if ($availableTags -notcontains $tag) { continue }
    $language = New-Object Windows.Globalization.Language $tag
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -ne $engine) {
      return @{ engine = $engine; languages = @($tag) }
    }
  }

  # 一个都没匹配上 → 用用户配置的默认引擎（通常是系统语言），并**如实报告**
  # 实际生效的语言，主进程据此提示用户「这台机器没装日文 OCR 包」。
  $fallback = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $fallback) { return $null }
  return @{ engine = $fallback; languages = @($fallback.RecognizerLanguage.LanguageTag) }
}

function Invoke-Probe {
  $created = New-OcrEngine -Languages @('ja-JP', 'en-US')
  if ($null -eq $created) {
    return @{ ok = $false; error = 'Windows 上没有可用的 OCR 语言包（Windows.Media.Ocr）' }
  }
  return @{ ok = $true; error = $null }
}

function Invoke-Page {
  param($Engine, [string]$Path)

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $result = Await ($Engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  # WinRT 的 OcrLine 只给整行文本 + 一组词（每个词的 BoundingRect **相对行**）。
  # 我们的协议要的是「原图像素 + 左上原点」的整行框，所以把词框并起来还原行框。
  $lines = @()
  foreach ($line in $result.Lines) {
    if ([string]::IsNullOrWhiteSpace($line.Text)) { continue }
    $minX = [double]::MaxValue; $minY = [double]::MaxValue
    $maxX = [double]::MinValue; $maxY = [double]::MinValue
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    if ($minX -eq [double]::MaxValue) { continue }
    # WinRT 的坐标已经是左上原点、单位是像素（SoftwareBitmap 的原始分辨率），
    # 与协议一致，不需要额外换算。
    $lines += @{
      text       = $line.Text
      confidence = 1.0  # WinRT 不给置信度；填 1.0 而不是 0，免得下游当它不可信
      box        = @($minX, $minY, $maxX, $maxY)
      vertical   = (($maxY - $minY) / [Math]::Max(1.0, ($maxX - $minX))) -ge 1.25
    }
  }

  return @{
    width  = $decoder.OrientedPixelWidth
    height = $decoder.OrientedPixelHeight
    lines  = $lines
  }
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

$probe = $false
$files = @()
$afterSeparator = $false
foreach ($arg in $Rest) {
  if ($arg -eq '--') { $afterSeparator = $true; continue }
  if (-not $afterSeparator -and $arg -eq '--probe') { $probe = $true; continue }
  if (-not $afterSeparator -and $arg -like '-*') { Fail "未知选项 $arg" 1 }
  $files += $arg
}

if ($probe) {
  $result = Invoke-Probe
  Emit-Json @{ kind = 'probe'; ok = $result.ok; error = $result.error }
  $stdout.Flush()
  exit $(if ($result.ok) { 0 } else { 3 })
}

if ($files.Count -eq 0) { Fail '没有给图片路径' 1 }

$requested = @('ja-JP', 'en-US')
$created = New-OcrEngine -Languages $requested
if ($null -eq $created) { Fail 'Windows 上没有可用的 OCR 语言包（Windows.Media.Ocr）' 1 }

Emit-Json @{ kind = 'meta'; engine = 'winrt-ocr'; languages = $created.languages; requested = $requested }

$succeeded = 0
foreach ($path in $files) {
  try {
    $page = Invoke-Page -Engine $created.engine -Path $path
    $succeeded++
    Emit-Json @{
      kind   = 'page'
      file   = $path
      ok     = $true
      width  = $page.width
      height = $page.height
      lines  = $page.lines
    }
  } catch {
    # 单页失败不能毁掉整本：协议允许逐页报错，主进程会把它算进「失败页数」。
    Emit-Json @{ kind = 'page'; file = $path; ok = $false; error = "$($_.Exception.Message)" }
  }
}

$stdout.Flush()
exit $(if ($succeeded -eq 0) { 2 } else { 0 })
