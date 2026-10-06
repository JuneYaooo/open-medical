# Windows 原生桌面控制:从 stdin 读取一条 JSON 指令,向 stdout 输出一条 JSON 结果。
# 支持 status / snapshot / focus / click / paste / key / capture,供微信桌面连接器调用。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeControl {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(IntPtr a, IntPtr b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
try { [void][NativeControl]::SetProcessDpiAwareness(2) } catch {}

# 不用 [Console]::In:其解码跟随系统 ANSI 代码页(GBK),UTF-8 中文会变乱码。直接读原始字节。
$stdinStream = [Console]::OpenStandardInput()
$stdinMemory = New-Object System.IO.MemoryStream
$stdinStream.CopyTo($stdinMemory)
$cmd = [System.Text.Encoding]::UTF8.GetString($stdinMemory.ToArray()) | ConvertFrom-Json
$stdinMemory.Dispose()
$fail = { param($msg) [Console]::Out.Write((@{ error = $msg } | ConvertTo-Json -Compress)); exit 1 }

function Get-WindowList {
  $result = New-Object System.Collections.ArrayList
  $cb = [NativeControl+EnumProc] { param($h, $l)
    if (-not [NativeControl]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][NativeControl]::GetWindowText($h, $sb, 512)
    $title = $sb.ToString()
    if (-not $title) { return $true }
    $rect = New-Object NativeControl+RECT
    if (-not [NativeControl]::GetWindowRect($h, [ref]$rect)) { return $true }
    if (($rect.Right - $rect.Left) -le 0 -or ($rect.Bottom - $rect.Top) -le 0) { return $true }
    $procId = 0
    [void][NativeControl]::GetWindowThreadProcessId($h, [ref]$procId)
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) { return $true }
    [void]$result.Add(@{ hwnd = $h.ToInt64(); title = $title; procId = $procId; process = $proc.ProcessName
      bounds = @{ X = $rect.Left; Y = $rect.Top; Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top } })
    return $true
  }
  [void][NativeControl]::EnumWindows($cb, [IntPtr]::Zero)
  return $result
}

function Select-WechatWindow($names) {
  $wanted = @($names | ForEach-Object { $_.ToLower() } | Where-Object { $_ })
  $exclude = '(聊天记录|朋友圈|小程序面板|登录|Log ?[Ii]n)'
  # WeChatAppEx 是微信内置浏览器/小程序运行时,绝不是聊天主窗口。
  $candidates = @(Get-WindowList | Where-Object {
    ($wanted -contains $_.process.ToLower() -or ($_.process -eq 'Weixin' -and $_.title -in @('微信', 'WeChat'))) -and
    $_.process -ne 'WeChatAppEx' -and $_.title -notmatch $exclude
  })
  $main = $candidates | Where-Object { $_.title -eq '微信' -or $_.title -eq 'WeChat' } | Select-Object -First 1
  if ($main) { return $main }
  return $candidates | Select-Object -First 1
}

function Send-Chord([string]$name) {
  # 支持 ctrl+a / ctrl+v / Return 等组合键:修饰键按住,主键按下再抬起,修饰键最后释放。
  $parts = @($name -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $modifiers = @(); $main = $null
  foreach ($p in $parts) {
    switch ($p.ToLower()) {
      'ctrl' { $modifiers += 0x11 } 'alt' { $modifiers += 0x12 } 'shift' { $modifiers += 0x10 }
      'return' { $main = 0x0D } 'enter' { $main = 0x0D } 'escape' { $main = 0x1B }
      'delete' { $main = 0x2E } 'backspace' { $main = 0x08 } 'tab' { $main = 0x09 }
      'down' { $main = 0x28 } 'up' { $main = 0x26 }
      default { if ($p.Length -eq 1) { $main = [byte][char]::ToUpper($p[0]) } else { throw "unsupported key $p" } }
    }
  }
  if (-not $main) { throw "unsupported key $name" }
  foreach ($m in $modifiers) { [NativeControl]::keybd_event([byte]$m, 0, 0, [UIntPtr]::Zero) | Out-Null }
  Start-Sleep -Milliseconds 20
  [NativeControl]::keybd_event([byte]$main, 0, 0, [UIntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 30
  [NativeControl]::keybd_event([byte]$main, 0, 2, [UIntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 20
  foreach ($m in $modifiers) { [NativeControl]::keybd_event([byte]$m, 0, 2, [UIntPtr]::Zero) | Out-Null }
}

function Focus-Window($hwnd) {
  $h = [IntPtr]$hwnd
  if ([NativeControl]::IsIconic($h)) { [void][NativeControl]::ShowWindow($h, 9) }
  # 最多重试 3 次;返回是否真的成为前台,调用方据此拒绝盲打按键。
  $ok = $false
  foreach ($i in 1..3) {
    $fgThread = 0
    [void][NativeControl]::GetWindowThreadProcessId([NativeControl]::GetForegroundWindow(), [ref]$fgThread)
    $thisThread = [NativeControl]::GetCurrentThreadId()
    $attached = [NativeControl]::AttachThreadInput($thisThread, $fgThread, $true)
    [void][NativeControl]::SetForegroundWindow($h)
    if ($attached) { [void][NativeControl]::AttachThreadInput($thisThread, $fgThread, $false) }
    Start-Sleep -Milliseconds 200
    if ([NativeControl]::GetForegroundWindow() -eq $h) { $ok = $true; break }
    [void][NativeControl]::ShowWindow($h, 6)  # SW_MINIMIZE 再还原,触发前台切换
    Start-Sleep -Milliseconds 150
    [void][NativeControl]::ShowWindow($h, 9)  # SW_RESTORE
    Start-Sleep -Milliseconds 250
  }
  return $ok
}

switch ($cmd.action) {
  'find-avatar' {
    # 在消息区左侧竖带内自底向上找最近的头像块:逐行统计彩色像素占比(背景/白底气泡不饱和),
    # 取最低的连续彩色块(高度占全图 3%–12%),返回其归一化区域与 8x8 平均哈希。
    Add-Type -AssemblyName System.Drawing
    $bytes = [Convert]::FromBase64String([string]$cmd.image)
    $msIn = New-Object System.IO.MemoryStream (,$bytes)
    $src = [System.Drawing.Image]::FromStream($msIn)
    $band = $cmd.band
    $bx = [int]([double]$band.x * $src.Width); $by = [int]([double]$band.y * $src.Height)
    $bw = [int]([double]$band.width * $src.Width); $bh = [int]([double]$band.height * $src.Height)
    if ($bw -le 0 -or $bh -le 0 -or $bx -lt 0 -or $by -lt 0 -or $bx + $bw -gt $src.Width -or $by + $bh -gt $src.Height) { $src.Dispose(); $msIn.Dispose(); & $fail '头像竖带超出截图范围' }
    $crop = New-Object System.Drawing.Bitmap($bw, $bh)
    $g = [System.Drawing.Graphics]::FromImage($crop)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $bw, $bh)), $bx, $by, $bw, $bh, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose(); $src.Dispose(); $msIn.Dispose()
    $step = [Math]::Max(1, [int]($bw / 24))
    $rowCount = [int[]]::new($bh)
    for ($yy = 0; $yy -lt $bh; $yy++) {
      $colorful = 0; $sampled = 0
      for ($xx = 0; $xx -lt $bw; $xx += $step) {
        $p = $crop.GetPixel($xx, $yy); $sampled++
        $mx = [Math]::Max($p.R, [Math]::Max($p.G, $p.B)); $mn = [Math]::Min($p.R, [Math]::Min($p.G, $p.B))
        if ($mx - $mn -gt 28 -or $mx -lt 90) { $colorful++ }
      }
      $rowCount[$yy] = $colorful
    }
    $minBlock = [int]([double]$bh * 0.12)
    $found = $null
    $yy = $bh - 1
    while ($yy -ge 0) {
      if ($rowCount[$yy] -gt ($step * 0.5)) {
        $top = $yy
        while ($top -gt 0 -and $rowCount[$top - 1] -gt ($step * 0.5)) { $top-- }
        $blockH = $yy - $top + 1
        if ($blockH -ge 8 -and $blockH -le [Math]::Max(16, [int]($bh * 0.25))) {
          $found = @{ top = $top; height = $blockH }; break
        }
        $yy = $top - 1
      } else { $yy-- }
    }
    if (-not $found) { $crop.Dispose(); [Console]::Out.Write((@{ found = $false } | ConvertTo-Json -Compress)); exit 0 }
    $small = New-Object System.Drawing.Bitmap(8, 8)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($crop, (New-Object System.Drawing.Rectangle(0, 0, 8, 8)), 0, [int]$found.top, [int]$bw, [int]$found.height, [System.Drawing.GraphicsUnit]::Pixel)
    $g2.Dispose()
    $crop.Dispose()
    $vals = New-Object 'System.Collections.Generic.List[Double]'
    for ($vyy = 0; $vyy -lt 8; $vyy++) { for ($vxx = 0; $vxx -lt 8; $vxx++) {
      $p = $small.GetPixel($vxx, $vyy)
      $vals.Add(0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
    } }
    $small.Dispose()
    $avg = ($vals | Measure-Object -Average).Average
    $bits = -join ($vals | ForEach-Object { if ($_ -ge $avg) { '1' } else { '0' } })
    $hex = -join (0..15 | ForEach-Object { [Convert]::ToString([Convert]::ToUInt16($bits.Substring($_ * 4, 4), 2), 16) })
    [Console]::Out.Write((@{
      found = $true
      region = @{
        x = [Math]::Round([double]$band.x, 6); y = [Math]::Round([double]$band.y + [double]$found.top / $bh * [double]$band.height, 6)
        width = [Math]::Round([double]$band.width, 6); height = [Math]::Round([double]$found.height / $bh * [double]$band.height, 6)
      }
      hash = $hex
    } | ConvertTo-Json -Compress))
  }
  'hash' {
    # 对截图的指定归一化区域做 8x8 平均哈希(头像指纹):裁剪 → 灰度 → 与均值比较得 64 位。
    Add-Type -AssemblyName System.Drawing
    $bytes = [Convert]::FromBase64String([string]$cmd.image)
    $msIn = New-Object System.IO.MemoryStream (,$bytes)
    $src = [System.Drawing.Image]::FromStream($msIn)
    $r = $cmd.region
    $cx = [int]([double]$r.x * $src.Width); $cy = [int]([double]$r.y * $src.Height)
    $cw = [int]([double]$r.width * $src.Width); $ch = [int]([double]$r.height * $src.Height)
    if ($cw -le 0 -or $ch -le 0 -or $cx -lt 0 -or $cy -lt 0 -or $cx + $cw -gt $src.Width -or $cy + $ch -gt $src.Height) { $src.Dispose(); $msIn.Dispose(); & $fail '头像区域超出截图范围' }
    $crop = New-Object System.Drawing.Bitmap($cw, $ch)
    $g = [System.Drawing.Graphics]::FromImage($crop)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), $cx, $cy, $cw, $ch, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose(); $src.Dispose(); $msIn.Dispose()
    $small = New-Object System.Drawing.Bitmap(8, 8)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($crop, 0, 0, 8, 8)
    $g2.Dispose()
    $vals = New-Object 'System.Collections.Generic.List[Double]'
    for ($yy = 0; $yy -lt 8; $yy++) { for ($xx = 0; $xx -lt 8; $xx++) {
      $p = $small.GetPixel($xx, $yy)
      $vals.Add(0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
    } }
    $small.Dispose()
    $avg = ($vals | Measure-Object -Average).Average
    $bits = -join ($vals | ForEach-Object { if ($_ -ge $avg) { '1' } else { '0' } })
    $hex = -join (0..15 | ForEach-Object { [Convert]::ToString([Convert]::ToUInt16($bits.Substring($_ * 4, 4), 2), 16) })
    # 近纯白区域(如空输入框)的 aHash 是退化的:补充深色像素计数作为「画面是否变化」的信号。
    $darkStep = [Math]::Max(1, [int]($cw / 64))
    $dark = 0
    for ($dy = 0; $dy -lt $ch; $dy += 2) { for ($dx = 0; $dx -lt $cw; $dx += $darkStep) {
      $dp = $crop.GetPixel($dx, $dy)
      if ((0.299 * $dp.R + 0.587 * $dp.G + 0.114 * $dp.B) -lt 128) { $dark++ }
    } }
    $crop.Dispose()
    [Console]::Out.Write((@{ hash = $hex; dark = $dark } | ConvertTo-Json -Compress))
  }
  'list' {
    $names = @([string]$cmd.app -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $wanted = @($names | ForEach-Object { $_.ToLower() })
    $exclude = '(聊天记录|朋友圈|小程序面板|登录|Log ?[Ii]n)'
    $all = @(Get-WindowList | Where-Object { ($wanted -contains $_.process.ToLower() -or $_.title -in @('微信', 'WeChat')) -and $_.title -notmatch $exclude })
    [Console]::Out.Write((@{ windows = $all } | ConvertTo-Json -Compress -Depth 5))
  }
  'status' {
    $names = @([string]$cmd.app -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $win = Select-WechatWindow $names
    [Console]::Out.Write((@{
      accessibility = $true; screenRecording = $true
      apps = @(if ($win) { ,@(@{ id = [string]$cmd.app }) } else { ,@() })
    } | ConvertTo-Json -Compress -Depth 5))
  }
  'snapshot' {
    $names = @([string]$cmd.app -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $win = Select-WechatWindow $names
    if (-not $win) { & $fail '未找到微信窗口' }
    [Console]::Out.Write((@{
      windowId = $win.hwnd; text = $win.title; process = $win.process; bounds = $win.bounds
    } | ConvertTo-Json -Compress -Depth 5))
  }
  'focus' {
    $names = @([string]$cmd.app -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $win = Select-WechatWindow $names
    if (-not $win) { & $fail '未找到微信窗口' }
    $ok = Focus-Window $win.hwnd
    [Console]::Out.Write((@{ focused = $ok; windowId = $win.hwnd } | ConvertTo-Json -Compress))
  }
  'click' {
    [void][NativeControl]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
    Start-Sleep -Milliseconds 60
    [NativeControl]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [NativeControl]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    [Console]::Out.Write((@{ clicked = $true } | ConvertTo-Json -Compress))
  }
  'paste' {
    [System.Windows.Forms.Clipboard]::SetText([string]$cmd.text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
    Start-Sleep -Milliseconds 80
    [NativeControl]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero) | Out-Null
    [NativeControl]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 30
    [NativeControl]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero) | Out-Null
    [NativeControl]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero) | Out-Null
    [Console]::Out.Write((@{ pasted = $true } | ConvertTo-Json -Compress))
  }
  'key' {
    Send-Chord ([string]$cmd.key)
    [Console]::Out.Write((@{ sent = $true } | ConvertTo-Json -Compress))
  }
  'capture' {
    Add-Type -AssemblyName System.Drawing
    $h = [IntPtr]([long]$cmd.windowId)
    $rect = New-Object NativeControl+RECT
    if (-not [NativeControl]::GetWindowRect($h, [ref]$rect)) { & $fail '窗口已关闭' }
    $w = $rect.Right - $rect.Left; $ht = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $ht -le 0) { & $fail '窗口尺寸无效' }
    $bmp = New-Object System.Drawing.Bitmap($w, $ht)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [NativeControl]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    if (-not $ok) { $bmp.Dispose(); & $fail '窗口截图失败' }
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    [Console]::Out.Write((@{ image = [Convert]::ToBase64String($ms.ToArray()); width = $w; height = $ht } | ConvertTo-Json -Compress))
    $ms.Dispose()
  }
  default { & $fail "未知操作 $($cmd.action)" }
}
