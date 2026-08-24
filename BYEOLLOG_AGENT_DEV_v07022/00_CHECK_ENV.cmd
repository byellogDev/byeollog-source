@echo off
setlocal
cd /d "%~dp0"
set "REQUIRED_SDK=8.0.424"
echo Checking .NET SDK %REQUIRED_SDK%...
where dotnet >nul 2>nul
if errorlevel 1 goto missing

dotnet --list-sdks
dotnet --list-sdks 2>nul | findstr /b /c:"%REQUIRED_SDK% " >nul
if errorlevel 1 goto wrong_version
echo.
echo Required SDK %REQUIRED_SDK% is installed. You can run 02_PUBLISH.cmd.
pause
exit /b 0

:wrong_version
echo.
echo Required SDK %REQUIRED_SDK% was not found.
echo Run 01_INSTALL_DOTNET8_SDK.cmd first.
pause
exit /b 1

:missing
echo.
echo .NET SDK was not found.
echo Run 01_INSTALL_DOTNET8_SDK.cmd first.
pause
exit /b 1
