@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "AUTOMATED="
if /i "%~1"=="--no-open" set "AUTOMATED=1"

set "PROJECT=HurogiCollector.csproj"
set "DIST=%~dp0DIST"
set "PKG=%DIST%\byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64"
set "ZIP=%DIST%\byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64.zip"
set "ZIP_HASH=%ZIP%.sha256.txt"
set "PUB=%~dp0bin\Release\net8.0-windows\win-x64\publish"
set "PS_RUNNER=powershell"
where pwsh >nul 2>nul
if not errorlevel 1 set "PS_RUNNER=pwsh"

echo.
echo ========================================================
echo  Byeollog Agent v0.7.0.32 - secure auto-update bootstrap
echo ========================================================
echo.

where dotnet >nul 2>nul
if errorlevel 1 goto no_sdk

set "SDK_VERSION="
for /f "delims=" %%S in ('dotnet --version 2^>nul') do set "SDK_VERSION=%%S"
if not defined SDK_VERSION goto no_sdk
echo %SDK_VERSION%| findstr /r /b "8\.0\." >nul
if errorlevel 1 goto wrong_sdk

if exist "%PKG%" goto output_conflict
if exist "%ZIP%" goto output_conflict
if exist "%ZIP_HASH%" goto output_conflict

echo [1/10] Cleaning old build...
dotnet clean "%PROJECT%" -c Release >nul 2>nul

echo [2/10] Restoring packages...
dotnet restore "%PROJECT%"
if errorlevel 1 goto fail

echo [3/10] Running Byeollog Agent regression tests...
dotnet run --project "AgentStoreTests\AgentStoreTests.csproj" -c Release
if errorlevel 1 goto fail

echo [4/10] Running source contracts...
where node >nul 2>nul
if errorlevel 1 goto no_node
node --test
if errorlevel 1 goto fail

echo [5/10] Publishing self-contained single EXE...
dotnet publish "%PROJECT%" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true
if errorlevel 1 goto fail
if not exist "%PUB%\byeollog.exe" goto no_exe

echo [6/10] Preparing immutable tester folder...
if not exist "%DIST%" mkdir "%DIST%" >nul 2>nul
if not exist "%DIST%" goto fail
mkdir "%PKG%" >nul 2>nul
if errorlevel 1 goto output_conflict
copy /y "%PUB%\byeollog.exe" "%PKG%\byeollog.exe" >nul
copy /y "%~dp0README_TESTER_v070_RC2_KO.txt" "%PKG%\README_TESTER_v070_RC2_KO.txt" >nul
copy /y "%~dp0G4_CANARY_v070_RC2_KO.md" "%PKG%\G4_CANARY_v070_RC2_KO.md" >nul
copy /y "%~dp0RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt" "%PKG%\RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt" >nul
copy /y "%~dp0INSTALL_OR_UPDATE.cmd" "%PKG%\INSTALL_OR_UPDATE.cmd" >nul
copy /y "%~dp0INSTALL_AND_CHECK.cmd" "%PKG%\INSTALL_AND_CHECK.cmd" >nul
copy /y "%~dp0RUN_G4_CANARY_PREP.cmd" "%PKG%\RUN_G4_CANARY_PREP.cmd" >nul
copy /y "%~dp0RUN_TESTER_READINESS.cmd" "%PKG%\RUN_TESTER_READINESS.cmd" >nul
copy /y "%~dp0Test-TesterEnvironment.ps1" "%PKG%\Test-TesterEnvironment.ps1" >nul
copy /y "%~dp0ROLLBACK_LAST_VERSION.cmd" "%PKG%\ROLLBACK_LAST_VERSION.cmd" >nul
copy /y "%~dp0VERIFY_INSTALL.cmd" "%PKG%\VERIFY_INSTALL.cmd" >nul
copy /y "%~dp0RESTORE_PREUPDATE_STATE.cmd" "%PKG%\RESTORE_PREUPDATE_STATE.cmd" >nul
copy /y "%~dp0LAUNCH_BYEOLLOG.cmd" "%PKG%\LAUNCH_BYEOLLOG.cmd" >nul
copy /y "%~dp0CREATE_SUPPORT_BUNDLE.cmd" "%PKG%\CREATE_SUPPORT_BUNDLE.cmd" >nul
copy /y "%~dp0RUN_REPLAY_CANDIDATE_CHECK.cmd" "%PKG%\RUN_REPLAY_CANDIDATE_CHECK.cmd" >nul
copy /y "%~dp0Collect-SupportBundle.ps1" "%PKG%\Collect-SupportBundle.ps1" >nul
copy /y "%~dp0Install-Byeollog.ps1" "%PKG%\Install-Byeollog.ps1" >nul
copy /y "%~dp0Byeollog-Launcher.ps1" "%PKG%\Byeollog-Launcher.ps1" >nul

REM Keep WebView2 native loader beside the EXE as a fallback.
if exist "%PUB%\WebView2Loader.dll" copy /y "%PUB%\WebView2Loader.dll" "%PKG%\WebView2Loader.dll" >nul
if exist "%PUB%\runtimes\win-x64\native\WebView2Loader.dll" copy /y "%PUB%\runtimes\win-x64\native\WebView2Loader.dll" "%PKG%\WebView2Loader.dll" >nul

echo [7/10] Creating complete release manifest v2 and package hashes...
%PS_RUNNER% -NoProfile -ExecutionPolicy Bypass -File "%~dp0New-ReleaseManifest.ps1" -PackageRoot "%PKG%" -Version "0.7.0.32"
if errorlevel 1 goto fail

echo [8/10] Verifying sealed tester package before ZIP creation...
%PS_RUNNER% -NoProfile -ExecutionPolicy Bypass -File "%PKG%\Install-Byeollog.ps1" -Mode VerifyPackage
if errorlevel 1 goto fail

echo [9/10] Creating tester ZIP...
%PS_RUNNER% -NoProfile -ExecutionPolicy Bypass -File "%~dp0Seal-TesterZip.ps1" -PackageRoot "%PKG%" -ZipPath "%ZIP%" -HashPath "%ZIP_HASH%"
if errorlevel 1 goto zip_fail

echo [10/10] Confirming round-trip verified ZIP and outer SHA-256 outputs...
if not exist "%ZIP%" goto zip_fail
if not exist "%ZIP_HASH%" goto zip_fail

echo.
echo ========================================================
echo  DONE - Tester package sealed and verified
echo ========================================================
echo.
echo Tester ZIP:
echo %ZIP%
echo.
echo ZIP SHA-256:
echo %ZIP_HASH%
echo.
if not defined AUTOMATED start "" "%DIST%"
if not defined AUTOMATED pause
exit /b 0

:no_sdk
echo.
echo ERROR: The SDK selected by global.json was not found on this PC.
echo Install the pinned .NET 8 SDK, then open a new CMD window.
if not defined AUTOMATED pause
exit /b 1

:wrong_sdk
echo.
echo ERROR: global.json did not select a .NET 8 SDK. Selected: %SDK_VERSION%
echo Install the pinned .NET 8 SDK before building this candidate.
if not defined AUTOMATED pause
exit /b 1

:output_conflict
echo.
echo ERROR: immutable-output-conflict
echo A v0.7.0.32 package folder, ZIP, or checksum already exists in DIST.
echo Existing same-version release bytes are never deleted or overwritten.
echo Preserve the existing output and use a new version for changed bytes.
if not defined AUTOMATED pause
exit /b 1

:no_node
echo.
echo ERROR: Node.js is required to verify the source contracts before packaging.
echo Install a current Node.js LTS release, then run this file again.
if not defined AUTOMATED pause
exit /b 1

:no_exe
echo.
echo ERROR: byeollog.exe was not created.
if not defined AUTOMATED pause
exit /b 1

:zip_fail
echo.
echo ERROR: EXE was created, but tester ZIP sealing failed.
echo Tester folder is here:
echo %PKG%
if not defined AUTOMATED pause
exit /b 1

:fail
echo.
echo BUILD FAILED. No existing user settings were deleted.
echo Copy the error text above or take a screenshot.
if not defined AUTOMATED pause
exit /b 1
