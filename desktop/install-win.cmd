@echo off
setlocal
set "SOURCE=%~dp0"
if not exist "%SOURCE%Open Medical.exe" set "SOURCE=%~dp0..\..\..\"
if not exist "%SOURCE%Open Medical.exe" (
  echo Installation package is incomplete.
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SOURCE%resources\app\desktop\install-win.ps1" %*
exit /b %ERRORLEVEL%
