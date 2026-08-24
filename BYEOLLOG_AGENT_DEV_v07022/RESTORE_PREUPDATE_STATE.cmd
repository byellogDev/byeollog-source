@echo off
setlocal EnableExtensions
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Byeollog.ps1" -Mode RestoreState
if errorlevel 1 goto fail
pause
exit /b 0
:fail
echo.
echo STATE RESTORE FAILED OR CANCELED. Existing state was not intentionally deleted.
pause
exit /b 1
