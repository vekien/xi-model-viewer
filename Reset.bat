@echo off
REM XI Model Viewer - reset to a first-run state.
REM
REM Renames every piece of stored state aside as "<name>.bak-<timestamp>", so the
REM next launch behaves exactly like a fresh install: no game path, no settings,
REM no xi-tools, nothing remembered. Nothing is deleted - see /restore below.
REM
REM   Reset.bat            park everything the viewer remembers (asks first)
REM   Reset.bat /restore   put the most recent backup of each back
setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "MODE=reset"
:args
if "%~1"=="" goto :args_done
if /i "%~1"=="/restore" set "MODE=restore"
if /i "%~1"=="/?"       goto :usage
if /i "%~1"=="-h"       goto :usage
if /i "%~1"=="--help"   goto :usage
shift
goto :args
:args_done

REM A sortable stamp, locale-independent: date formats vary by region.
for /f "delims=" %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"

REM The two places the viewer keeps anything. XI_DATA_DIR names the PARENT of the
REM data folder, matching user_data_dir_path() in src-tauri/src/main.rs, and the
REM WebView2 profile is keyed by the identifier in tauri.conf.json - that is the
REM one holding localStorage, which is where every setting actually lives.
set "DATA_DIR=%LOCALAPPDATA%\XiModelViewer"
if defined XI_DATA_DIR set "DATA_DIR=%XI_DATA_DIR%\XiModelViewer"
set "WEBVIEW_DIR=%LOCALAPPDATA%\uk.co.viion.ximodelviewer\EBWebView"

tasklist /fi "imagename eq xi-model-viewer.exe" 2>nul | find /i "xi-model-viewer.exe" >nul
if not errorlevel 1 (
    echo.
    echo The viewer is still running. Close it first - it would just write its
    echo settings back out again on exit.
    echo.
    pause
    exit /b 1
)

if "%MODE%"=="restore" goto :restore

echo.
echo This will park the following aside, so the next launch is a first run:
echo.
echo   [park]    Settings, scenes and window state
echo             %WEBVIEW_DIR%
echo             Game / HD / pivot / navmesh paths, saved scenes, and every
echo             viewer option - all of it lives in localStorage.
if exist "%WEBVIEW_DIR%" (echo.) else (echo             ^(nothing there yet^)
echo.)
echo   [park]    Downloaded data and tools
echo             %DATA_DIR%
call :inside "xi-tools"          "xi-tools install, and the .env inside it"
call :inside "xi-tools-path.txt" "your custom xi-tools folder, if you set one"
call :inside "lists"             "DAT lists downloaded since this build"
call :inside "vgmstream"         "vgmstream audio decoder"
call :inside "db"                "imported client database (re-importable)"
call :inside "notes.json"        "YOUR DAT NOTES - hand written, not recoverable elsewhere"
echo.
echo Nothing is deleted. Each becomes "<name>.bak-%STAMP%",
echo and "Reset.bat /restore" puts them back.
echo.
echo A local xi-tools checkout is left alone: only the pointer to it is parked,
echo so the viewer forgets it. Its .env is shared with other apps.
echo.
choice /c YN /n /m "Continue? [Y/N] "
if errorlevel 2 goto :cancelled

echo.
call :park "%WEBVIEW_DIR%"
call :park "%DATA_DIR%"

echo.
echo Done. Launch the viewer for a clean first run.
echo Undo with: Reset.bat /restore
echo.
pause
exit /b 0

:restore
echo.
echo Restoring the most recent backup of each...
echo.
call :unpark "%WEBVIEW_DIR%"
call :unpark "%DATA_DIR%"
echo.
pause
exit /b 0

:cancelled
echo.
echo Cancelled - nothing was touched.
echo.
pause
exit /b 0

:usage
echo.
echo   Reset.bat            park everything the viewer remembers
echo   Reset.bat /restore   put the most recent backup of each back
echo.
exit /b 0

REM ── helpers ─────────────────────────────────────────────────────────────────

REM :inside <name> <what it is>  - one line per thing in the data folder, so the
REM preview names what is going rather than just the folder holding it.
:inside
if exist "%DATA_DIR%\%~1" echo               - %~2
exit /b 0

REM :park <path>  - rename aside. Works for both files and directories.
:park
if not exist "%~1" (
    echo   absent    %~1
    exit /b 0
)
move "%~1" "%~1.bak-%STAMP%" >nul 2>&1
if errorlevel 1 (
    echo   FAILED    %~1
    echo             Something still has it open.
) else (
    echo   parked    %~1
)
exit /b 0

REM :unpark <path>  - restore the newest .bak-* beside it, setting any current
REM copy aside first so a restore is itself undoable.
:unpark
set "NEWEST="
for /f "delims=" %%b in ('dir /b /o-n "%~1.bak-*" 2^>nul') do (
    if not defined NEWEST set "NEWEST=%~dp1%%b"
)
if not defined NEWEST (
    echo   no backup %~1
    exit /b 0
)
if exist "%~1" move "%~1" "%~1.firstrun-%STAMP%" >nul 2>&1
move "!NEWEST!" "%~1" >nul 2>&1
if errorlevel 1 (
    echo   FAILED    %~1
) else (
    echo   restored  %~1
)
exit /b 0
