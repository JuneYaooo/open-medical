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
  $candidates = @(Get-WindowList | Where-Object {
    ($wanted -contains $_.process.ToLower() -or $_.title -in @('微信', 'WeChat')) -and $_.title -notmatch $exclude
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
  $fgThread = 0
  [void][NativeControl]::GetWindowThreadProcessId([NativeControl]::GetForegroundWindow(), [ref]$fgThread)
  $thisThread = [NativeControl]::GetCurrentThreadId()
  $attached = [NativeControl]::AttachThreadInput($thisThread, $fgThread, $true)
  [void][NativeControl]::SetForegroundWindow($h)
  if ($attached) { [void][NativeControl]::AttachThreadInput($thisThread, $fgThread, $false) }
  Start-Sleep -Milliseconds 150
}

switch ($cmd.action) {
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
    Focus-Window $win.hwnd
    [Console]::Out.Write((@{ focused = $true; windowId = $win.hwnd } | ConvertTo-Json -Compress))
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
