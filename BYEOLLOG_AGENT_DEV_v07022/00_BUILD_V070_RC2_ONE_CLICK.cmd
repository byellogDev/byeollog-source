@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo [WINDOWS CMD FIX2] Byeollog Agent bootstrap started.

set "AUTOMATED="
if /i "%~1"=="--no-open" set "AUTOMATED=1"

set "DOTNET_DIR=%ProgramFiles%\dotnet"
set "REQUIRED_SDK=8.0.424"

where dotnet >nul 2>nul
if not errorlevel 1 goto check_sdk

if exist "%DOTNET_DIR%\dotnet.exe" (
  set "PATH=%DOTNET_DIR%;%PATH%"
  goto check_sdk
)

:install_sdk
if defined INSTALL_ATTEMPTED goto install_failed
set "INSTALL_ATTEMPTED=1"
echo.
echo .NET SDK %REQUIRED_SDK% is required to build Byeollog Agent v0.7.0.32.
choice /c YN /n /m "Install or update it now with Windows Package Manager? [Y/N] "
if errorlevel 2 goto canceled

where winget >nul 2>nul
if errorlevel 1 goto no_winget

winget install --id Microsoft.DotNet.SDK.8 --exact --version %REQUIRED_SDK% --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto install_failed

if not exist "%DOTNET_DIR%\dotnet.exe" goto install_failed
set "PATH=%DOTNET_DIR%;%PATH%"

:check_sdk
dotnet --list-sdks 2>nul | findstr /b /c:"%REQUIRED_SDK% " >nul
if errorlevel 1 goto install_sdk

:publish
call "%~dp002_PUBLISH.cmd" %*
exit /b %errorlevel%

:canceled
echo.
echo Build canceled. No project files were changed.
if not defined AUTOMATED pause
exit /b 1

:no_winget
echo.
echo ERROR: Windows Package Manager was not found.
echo Install the .NET 8 SDK, then run this file again.
if not defined AUTOMATED pause
exit /b 1

:install_failed
echo.
echo ERROR: The required .NET SDK %REQUIRED_SDK% installation did not finish successfully.
echo Take a screenshot of this window and send it to the Byeollog developer.
if not defined AUTOMATED pause
exit /b 1
