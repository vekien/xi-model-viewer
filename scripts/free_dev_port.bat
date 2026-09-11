@echo off
REM Free the Vite dev port before starting the app.
REM
REM   free_dev_port.bat [port]        (default 5173)
REM
REM ui/vite.config.js pins the port with strictPort so tauri.conf.json's devUrl
REM stays valid, which means a leftover dev server -- a previous run that did not
REM shut down cleanly, or one started by hand for browser testing (see AGENTS.md)
REM -- makes Start.bat die on startup with "Port 5173 is already in use".
REM
REM Only a LISTENING socket on that exact port is touched, and only when a
REM dev-server process owns it. Anything else is named and left alone: the port
REM being busy is worth reporting, but killing an unrecognised process to take it
REM is not this script's call to make.
setlocal EnableExtensions
set "DEVPORT=%~1"
if "%DEVPORT%"=="" set "DEVPORT=5173"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = %DEVPORT%;" ^
  "$owners = @(Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue |" ^
  "            Select-Object -ExpandProperty OwningProcess -Unique);" ^
  "if (-not $owners) { exit 0 };" ^
  "$known = @('node','cargo','xi-model-viewer','python','py');" ^
  "foreach ($id in $owners) {" ^
  "  $proc = Get-Process -Id $id -EA SilentlyContinue;" ^
  "  if (-not $proc) { continue };" ^
  "  if ($known -notcontains $proc.ProcessName) {" ^
  "    Write-Host \"Port $p is held by $($proc.ProcessName) (pid $id) - leaving it alone.\";" ^
  "    continue" ^
  "  };" ^
  "  Write-Host \"Stopping leftover dev server on port $p ($($proc.ProcessName), pid $id).\";" ^
  "  try { Stop-Process -Id $id -Force -EA Stop } catch { Write-Host \"  could not stop pid ${id}: $_\" }" ^
  "};" ^
  "1..30 | ForEach-Object {" ^
  "  if (-not (Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue)) { exit 0 };" ^
  "  Start-Sleep -Milliseconds 100" ^
  "};" ^
  "exit 0"

endlocal
exit /b 0
