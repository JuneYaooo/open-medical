@echo off
setlocal
set "SOURCE=%~dp0"
if not exist "%SOURCE%Open Medical.exe" set "SOURCE=%~dp0..\..\..\"
set "ELECTRON_RUN_AS_NODE=1"
"%SOURCE%Open Medical.exe" "%SOURCE%resources\app\scripts\workspace-cli.mjs" %*
exit /b %ERRORLEVEL%
