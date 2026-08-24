@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "AUTOMATED="
if /i "%~1"=="--no-pause" set "AUTOMATED=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Test-TesterEnvironment.ps1"
if errorlevel 2 goto blocked
if errorlevel 1 goto failed
echo.
echo READY. Warnings may remain until OBS is running.
if not defined AUTOMATED pause
exit /b 0
:blocked
echo.
echo TESTER READINESS IS BLOCKED. Fix the BLOCKED item above before installation.
if not defined AUTOMATED pause
exit /b 2
:failed
echo.
echo TESTER READINESS CHECK FAILED.
if not defined AUTOMATED pause
exit /b 1
