@echo off
rem ============================================================
rem  Anime Archive Helper - stop the local service
rem  Kills the recorded PID (no leftover process).
rem  Keep this file ASCII-only.
rem ============================================================
setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"
set "SERVER_DIR=%SCRIPT_DIR%.."
set "RUNTIME=%SERVER_DIR%\data\runtime.json"

if not exist "%RUNTIME%" goto :byport

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-Content -Raw '%RUNTIME%' | ConvertFrom-Json).pid"`) do set "SVC_PID=%%P"

if defined SVC_PID (
  echo [*] Stopping local service PID=!SVC_PID! ...
  taskkill /PID !SVC_PID! /T /F >nul 2>&1
  if errorlevel 1 (
    echo [i] Process !SVC_PID! is already gone.
  ) else (
    echo [ok] Stopped PID !SVC_PID!.
  )
)
del /q "%RUNTIME%" >nul 2>&1
goto :end

:byport
echo [*] runtime.json not found; freeing ports 9999-10010 ...
for /l %%N in (9999,1,10010) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%%N .*LISTENING"') do (
    taskkill /PID %%A /T /F >nul 2>&1
  )
)

:end
echo.
echo [*] Cleaning up any leftover archive-helper node processes ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*dist\\index.js*' -or $_.CommandLine -like '*anime*archive*server*' } | ForEach-Object { Write-Host ('[ok] Stopped PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul

echo [done] Local service stopped.
endlocal
