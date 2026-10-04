# Windows 本地文字识别:stdin 传入 {image:<base64>, region?:{x,y,width,height}},stdout 输出
# {width,height,lines:[{text,confidence,box:{x,y,width,height}}]}。坐标为相对整图的 0–1 归一化值,
# region 只做行过滤,不改变坐标系。使用系统自带的 Windows.Media.Ocr,无需联网。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$fail = { param($msg) [Console]::Out.Write((@{ error = $msg } | ConvertTo-Json -Compress)); exit 1 }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
} catch { & $fail '此系统缺少 Windows 运行时 OCR 组件' }

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
if (-not $asTaskGeneric) { & $fail '无法初始化 Windows 运行时异步桥' }
function Await($WinRtOperation, [Type]$ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtOperation))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (-not $req.image) { & $fail '缺少图片数据' }
$bytes = [Convert]::FromBase64String($req.image)
if ($bytes.Length -gt 4MB) { & $fail '图片超过 4MB' }

# PNG 尺寸直接读 IHDR,避免完整解码两遍。
if ($bytes.Length -lt 24 -or $bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50) { & $fail '仅支持 PNG 窗口截图' }
$width = [int](([uint32]$bytes[16] -shl 24) -bor ([uint32]$bytes[17] -shl 16) -bor ([uint32]$bytes[18] -shl 8) -bor [uint32]$bytes[19])
$height = [int](([uint32]$bytes[20] -shl 24) -bor ([uint32]$bytes[21] -shl 16) -bor ([uint32]$bytes[22] -shl 8) -bor [uint32]$bytes[23])
if ($width -le 0 -or $height -le 0) { & $fail '图片尺寸无效' }

$engine = $null
foreach ($tag in @('zh-Hans-CN', 'zh-Hant-CN', 'en-US')) {
  try {
    $lang = New-Object Windows.Globalization.Language($tag)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    if ($engine) { break }
  } catch {}
}
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { & $fail '未安装 OCR 识别语言包，请在系统设置的“时间和语言→语言”中添加中文并安装文本识别组件' }

# 小字号 UI 文本直接识别质量差:先高质量放大再识别(不超过引擎最大边长与 4 倍上限)。
$scale = 1.0
if ($req.scale) { $scale = [Math]::Min(4.0, [Math]::Max(1.0, [double]$req.scale)) }
try { $maxDim = [double]$engine.MaxImageDimension } catch { $maxDim = 0 }
if ($maxDim -gt 0) { $scale = [Math]::Min($scale, [Math]::Max(1.0, $maxDim / [Math]::Max($width, $height))) }
if ($scale -gt 1.01) {
  Add-Type -AssemblyName System.Drawing
  $msIn = New-Object System.IO.MemoryStream (,$bytes)
  $srcBitmap = [System.Drawing.Image]::FromStream($msIn)
  $w2 = [int][Math]::Round($width * $scale); $h2 = [int][Math]::Round($height * $scale)
  $big = New-Object System.Drawing.Bitmap($w2, $h2)
  $g2 = [System.Drawing.Graphics]::FromImage($big)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.DrawImage($srcBitmap, 0, 0, $w2, $h2)
  $g2.Dispose()
  $msOut = New-Object System.IO.MemoryStream
  $big.Save($msOut, [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose(); $srcBitmap.Dispose(); $msIn.Dispose()
  $bytes = $msOut.ToArray(); $msOut.Dispose()
  $width = $w2; $height = $h2
}

$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
$writer.WriteBytes([byte[]]$bytes)
$flushTask = Await ($writer.StoreAsync()) ([UInt32])
$writer.Dispose()
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync(
    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

$scaleX = 1.0 / $width; $scaleY = 1.0 / $height
$region = $null
if ($req.region -and $req.region.width -gt 0 -and $req.region.height -gt 0) { $region = $req.region }
$lines = @()
foreach ($line in $result.Lines) {
  $left = [double]::MaxValue; $top = [double]::MaxValue; $right = [double]::MinValue; $bottom = [double]::MinValue
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    $left = [Math]::Min($left, $r.X); $top = [Math]::Min($top, $r.Y)
    $right = [Math]::Max($right, $r.X + $r.Width); $bottom = [Math]::Max($bottom, $r.Y + $r.Height)
  }
  if ($right -le $left) { continue }
  $box = @{
    x = [Math]::Round($left * $scaleX, 6); y = [Math]::Round($top * $scaleY, 6)
    width = [Math]::Round(($right - $left) * $scaleX, 6); height = [Math]::Round(($bottom - $top) * $scaleY, 6)
  }
  if ($region) {
    $inRegion = ($box.x + $box.width) -ge $region.x -and $box.x -le ($region.x + $region.width) -and
      ($box.y + $box.height) -ge $region.y -and $box.y -le ($region.y + $region.height)
    if (-not $inRegion) { continue }
  }
  $text = $line.Text
  if ($text) { $lines += ,@{ text = $text; confidence = 0.95; box = $box } }
}

[Console]::Out.Write((@{
  width = $width; height = $height
  language = $engine.RecognizerLanguage.LanguageTag
  lines = $lines
} | ConvertTo-Json -Compress -Depth 6))
