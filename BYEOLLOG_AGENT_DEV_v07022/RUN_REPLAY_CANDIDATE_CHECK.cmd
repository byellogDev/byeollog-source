@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "NO_PAUSE="
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"
set "INSTALLED_LAUNCHER=%LOCALAPPDATA%\Programs\ByeollogCollector\Byeollog-Launcher.ps1"

if not exist "%INSTALLED_LAUNCHER%" goto not_installed
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALLED_LAUNCHER%" --replay-candidate-check
if errorlevel 1 goto failed
echo.
echo REPLAY CANDIDATE CHECK PASSED. NO LIVE EVENT WAS USED.
echo Result JSON: %LOCALAPPDATA%\ByeollogAgent\tester-results\v070_RC2
if not defined NO_PAUSE pause
exit /b 0

:not_installed
echo.
echo BYEOLLOG AGENT IS NOT INSTALLED. Run INSTALL_AND_CHECK.cmd first.
goto failed

:failed
echo.
echo REPLAY CANDIDATE CHECK WAS BLOCKED. DO NOT USE A LIVE EVENT.
echo Run VERIFY_INSTALL.cmd, then CREATE_SUPPORT_BUNDLE.cmd if requested.
if not defined NO_PAUSE pause
exit /b 1
