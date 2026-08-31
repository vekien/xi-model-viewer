@echo off
REM Put RC.EXE (the Windows resource compiler) on PATH for the Rust MSVC link step.
REM
REM Shared by Start.bat and Build.bat. It lived inline in both and had already
REM drifted - Build grew progress echoes and a longer error, Start did not - so a
REM fix to one silently missed the other. Keep it here.
REM
REM No setlocal: the PATH / RC exports below have to reach the caller.
REM Exit 0 = rc is usable, 1 = not found.

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
echo then try again.
exit /b 1
