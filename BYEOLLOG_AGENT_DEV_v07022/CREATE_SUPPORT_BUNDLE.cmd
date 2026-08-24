@echo off
setlocal EnableExtensions
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Collect-SupportBundle.ps1"
if errorlevel 1 goto fail
pause
exit /b 0
:fail
echo.
echo SUPPORT BUNDLE CREATION FAILED.
echo Take a screenshot of this window and send it to the Byeollog developer.
pause
exit /b 1
