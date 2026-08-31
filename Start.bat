@echo off
REM XI Model Viewer - DEV / watch mode.
REM   Runs the app against the Vite dev server: frontend edits hot-reload
REM   instantly, and Rust edits trigger an automatic rebuild + restart.
REM   For a standalone release exe instead, use Build.bat.
setlocal EnableExtensions
set "ROOT=%~dp0"
cd /d "%ROOT%"

call "%ROOT%scripts\ensure_rc.bat"
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
echo Starting XI Model Viewer in dev mode - hot reload enabled.
echo Close the app window ^(or press Ctrl+C here^) to stop.
echo.
REM Run from the repo root so beforeDevCommand's "cd ui" resolves correctly.
cargo tauri dev
exit /b %errorlevel%

:error
echo.
echo Setup failed. Make sure Node.js, the Rust toolchain, and Visual Studio
echo Build Tools ^(Desktop development with C++ / Windows SDK^) are installed.
pause
exit /b 1
