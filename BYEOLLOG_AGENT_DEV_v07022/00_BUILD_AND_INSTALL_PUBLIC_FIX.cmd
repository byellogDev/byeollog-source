@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ========================================================
echo  Byeollog Agent 0.7.0.32 Secure Auto-Update Bootstrap
echo ========================================================
echo.
echo This updates the Agent without deleting existing settings.
echo.

call "%~dp000_BUILD_V070_RC2_ONE_CLICK.cmd" --no-open
if errorlevel 1 goto fail

set "PACKAGE=%~dp0DIST\byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64"
if not exist "%PACKAGE%\INSTALL_AND_CHECK.cmd" goto missing_package

call "%PACKAGE%\INSTALL_AND_CHECK.cmd" --no-pause
if errorlevel 1 goto fail

echo.
echo ========================================================
echo  DONE - Byeollog Agent 0.7.0.32 installed successfully
echo ========================================================
echo.
echo Open Byeollog Agent and sign in normally.
echo User data is now stored under %%LOCALAPPDATA%%\ByeollogAgent.
pause
exit /b 0

:missing_package
echo.
echo ERROR: The verified release package was not created.
goto fail

:fail
echo.
echo UPDATE FAILED. Existing settings and installed versions were not deleted.
echo Take a screenshot of this window and send it to the Byeollog developer.
pause
exit /b 1
