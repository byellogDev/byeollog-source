@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "AUTOMATED="
if /i "%~1"=="--no-pause" set "AUTOMATED=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Byeollog.ps1" -Mode Install
if errorlevel 1 goto fail
echo.
echo Installation completed successfully.
if not defined AUTOMATED pause
exit /b 0
:fail
echo.
echo INSTALL OR UPDATE FAILED. No user settings were deleted.
if not defined AUTOMATED pause
exit /b 1
