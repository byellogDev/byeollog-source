@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "AUTOMATED="
if /i "%~1"=="--no-pause" set "AUTOMATED=1"
call "%~dp0RUN_TESTER_READINESS.cmd" --no-pause
if errorlevel 1 goto fail
call "%~dp0INSTALL_OR_UPDATE.cmd" --no-pause
if errorlevel 1 goto fail
call "%~dp0VERIFY_INSTALL.cmd" --no-pause
if errorlevel 1 goto fail
echo.
echo READINESS, INSTALLATION, AND APP INTEGRITY CHECK COMPLETED.
if not defined AUTOMATED pause
exit /b 0
:fail
echo.
echo INSTALLATION OR CHECK FAILED. Run CREATE_SUPPORT_BUNDLE.cmd if the issue repeats.
if not defined AUTOMATED pause
exit /b 1
