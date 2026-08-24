@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "AUTOMATED="
if /i "%~1"=="--no-pause" set "AUTOMATED=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Byeollog.ps1" -Mode Verify
if errorlevel 1 goto fail
if not defined AUTOMATED pause
exit /b 0
:fail
echo.
echo INSTALLED FILE VERIFICATION FAILED.
if not defined AUTOMATED pause
exit /b 1
