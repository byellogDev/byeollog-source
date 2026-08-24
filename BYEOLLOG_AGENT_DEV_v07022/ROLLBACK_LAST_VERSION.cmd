@echo off
setlocal EnableExtensions
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Byeollog.ps1" -Mode Rollback
if errorlevel 1 goto fail
pause
exit /b 0
:fail
echo.
echo ROLLBACK FAILED OR CANCELED. No user settings were deleted.
pause
exit /b 1
