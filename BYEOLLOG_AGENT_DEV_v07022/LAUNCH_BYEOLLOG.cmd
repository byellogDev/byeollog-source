@echo off
setlocal EnableExtensions
set "INSTALLED_LAUNCHER=%LOCALAPPDATA%\Programs\ByeollogCollector\Byeollog-Launcher.ps1"
if not exist "%INSTALLED_LAUNCHER%" (
  echo Byeollog Agent is not installed. Run INSTALL_AND_CHECK.cmd first.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALLED_LAUNCHER%" %*
if errorlevel 1 (
  echo.
  echo Byeollog Agent could not start. Run VERIFY_INSTALL.cmd from the release package.
  pause
  exit /b 1
)
exit /b 0
