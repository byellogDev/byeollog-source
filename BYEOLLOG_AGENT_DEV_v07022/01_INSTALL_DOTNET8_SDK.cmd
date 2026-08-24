@echo off
setlocal
set "REQUIRED_SDK=8.0.424"
set "DOTNET_DIR=%ProgramFiles%\dotnet"
echo Installing .NET SDK %REQUIRED_SDK% with winget...
where winget >nul 2>nul
if errorlevel 1 goto no_winget
winget install --id Microsoft.DotNet.SDK.8 --exact --version %REQUIRED_SDK% --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto install_failed
if exist "%DOTNET_DIR%\dotnet.exe" set "PATH=%DOTNET_DIR%;%PATH%"
dotnet --list-sdks 2>nul | findstr /b /c:"%REQUIRED_SDK% " >nul
if errorlevel 1 goto install_failed
echo.
echo SDK %REQUIRED_SDK% is installed. Close this window and open a new CMD window before publishing.
pause
exit /b 0

:install_failed
echo ERROR: Required SDK %REQUIRED_SDK% was not installed.
pause
exit /b 1

:no_winget
echo ERROR: winget was not found.
echo Install the .NET SDK %REQUIRED_SDK% manually from Microsoft's .NET download page.
pause
exit /b 1
