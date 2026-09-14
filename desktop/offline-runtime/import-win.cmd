@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0import-win.ps1"
exit /b %ERRORLEVEL%
