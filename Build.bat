@echo off
REM XI Model Viewer - production build (embeds the Vite frontend into the exe).
REM Do NOT use plain `cargo build` — that leaves the app pointed at localhost:5173.
setlocal EnableExtensions
set "ROOT=%~dp0"
set "RELDIR=%ROOT%src-tauri\target\release"
set "EXE=%RELDIR%\xi-model-viewer.exe"

cd /d "%ROOT%"

REM ---------------------------------------------------------------------------
REM MSVC / Windows SDK: tauri-winres needs RC.EXE on PATH (or RC set).
REM ---------------------------------------------------------------------------
call :ensure_rc
if errorlevel 1 goto :error

REM First-run frontend dependencies.
if not exist "ui\node_modules" (
    echo Installing frontend dependencies ^(one-time^)...
    pushd ui
    call npm install || goto :error
    popd
)

REM Ensure the Tauri CLI is available (one-time install).
cargo tauri --version >nul 2>&1
if errorlevel 1 (
    echo Installing Tauri CLI ^(one-time, a few minutes^)...
    cargo install tauri-cli --version "^2" --locked || goto :error
)

echo.
echo Building XI Model Viewer release ^(Vite + Tauri^)...
echo.
REM `tauri build` runs beforeBuildCommand (npm run build), embeds ui/dist,
REM and produces a standalone exe that does not need a local dev server.
cargo tauri build --no-bundle || goto :error

REM Keep vgmstream next to the exe (dev fast-path; it's also embedded in the exe).
if not exist "%RELDIR%\vgmstream\vgmstream-cli.exe" (
    if exist "%ROOT%src-tauri\vgmstream\vgmstream-cli.exe" (
        xcopy /E /I /Y "%ROOT%src-tauri\vgmstream" "%RELDIR%\vgmstream" >nul
    )
)

echo.
echo Build complete: "%EXE%"
explorer /select,"%EXE%"
exit /b 0

:error
echo.
echo Build failed.
echo Make sure Node.js, the Rust toolchain, and Visual Studio Build Tools
echo ^(with Desktop development with C++ / Windows SDK^) are installed.
echo RC.EXE is required to embed the Windows icon/resources.
pause
exit /b 1

REM ----- locate RC.EXE -------------------------------------------------------
:ensure_rc
where rc >nul 2>&1
if not errorlevel 1 (
    echo Using RC.EXE from PATH.
    exit /b 0
)

REM Prefer VsDevCmd / vcvars if Visual Studio is installed (gives cl+link+rc).
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do (
        if exist "%%i\VC\Auxiliary\Build\vcvars64.bat" (
            echo Loading Visual Studio x64 build environment...
            call "%%i\VC\Auxiliary\Build\vcvars64.bat" >nul
            where rc >nul 2>&1
            if not errorlevel 1 exit /b 0
        )
    )
)

REM Fallback: newest Windows SDK rc.exe (x64).
set "SDK_BIN=%ProgramFiles(x86)%\Windows Kits\10\bin"
if exist "%SDK_BIN%" (
    for /f "delims=" %%v in ('dir /b /ad /o-n "%SDK_BIN%" 2^>nul') do (
        if exist "%SDK_BIN%\%%v\x64\rc.exe" (
            echo Using Windows SDK RC.EXE: %%v\x64
            set "PATH=%SDK_BIN%\%%v\x64;%PATH%"
            set "RC=%SDK_BIN%\%%v\x64\rc.exe"
            exit /b 0
        )
    )
)

echo.
echo ERROR: RC.EXE not found.
echo Install "Desktop development with C++" ^(Visual Studio^) or the Windows SDK,
echo then re-run Build.bat.
exit /b 1
