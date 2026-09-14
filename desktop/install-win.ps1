param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Open Medical'), [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$destination = [IO.Path]::GetFullPath($Destination)
if (!(Test-Path (Join-Path $source 'Open Medical.exe')) -or !(Test-Path (Join-Path $source 'resources\app\dist\index.html'))) { throw '安装包不完整。' }
if ($source.TrimEnd('\') -eq $destination.TrimEnd('\')) { if (!$NoLaunch) { Start-Process (Join-Path $destination 'Open Medical.exe') }; exit 0 }
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $destination 'Open Medical.exe') }
if ($running) { throw '请先退出已经安装的 Open Medical，然后重试。' }
$parent = Split-Path -Parent $destination
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$stage = Join-Path $parent ('.open-medical-stage-' + [guid]::NewGuid())
$previous = Join-Path $parent ('.open-medical-previous-' + [guid]::NewGuid())
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force }
  if (!(Test-Path (Join-Path $stage 'resources\app\server\core\extensions.mjs'))) { throw '复制后的安装包校验失败。' }
  if (Test-Path $destination) { Move-Item -LiteralPath $destination -Destination $previous }
  try { Move-Item -LiteralPath $stage -Destination $destination } catch { if (Test-Path $previous) { Move-Item -LiteralPath $previous -Destination $destination }; throw }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder 'Open Medical.lnk'))
    $shortcut.TargetPath = Join-Path $destination 'Open Medical.exe'
    $shortcut.WorkingDirectory = $destination
    $shortcut.Save()
  }
  Write-Host ('安装完成：' + $destination)
  if (!$NoLaunch) { Start-Process (Join-Path $destination 'Open Medical.exe') }
} finally {
  if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  if ((Test-Path $previous) -and (Test-Path $destination)) { Remove-Item -LiteralPath $previous -Recurse -Force }
}
