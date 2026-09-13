@echo off
rem ============================================================
rem  Anime Archive Helper - one-click start (no console window)
rem  Same as double-clicking bin\start.vbs; can be used as a
rem  desktop shortcut target.
rem  Keep this file ASCII-only.
rem ============================================================
setlocal
set "SCRIPT_DIR=%~dp0"
cscript //nologo "%SCRIPT_DIR%start.vbs"
endlocal
