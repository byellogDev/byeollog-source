@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ========================================================
echo  BYEOLLOG AGENT v0.7.0 RC2 - G4 ONE-TIME PREPARATION
echo ========================================================
echo.
echo This prepares the PC without creating a live event.
echo The actual live G4 canary is performed once from the tray menu.
echo.

call "%~dp0INSTALL_AND_CHECK.cmd" --no-pause
if errorlevel 1 goto fail

call "%~dp0RUN_REPLAY_CANDIDATE_CHECK.cmd" --no-pause
if errorlevel 1 goto fail

call "%~dp0LAUNCH_BYEOLLOG.cmd"
if errorlevel 1 goto fail

echo.
echo PREPARATION PASSED. NO LIVE EVENT WAS USED.
echo Sign in once, then follow G4_CANARY_v070_RC2_KO.md.
echo Run the tray item marked "actual event once" only when instructed.
pause
exit /b 0

:fail
echo.
echo G4 PREPARATION STOPPED. DO NOT USE A LIVE EVENT.
echo Run CREATE_SUPPORT_BUNDLE.cmd only if support evidence is requested.
pause
exit /b 1
