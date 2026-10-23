@echo off
REM Double-click me on Thursdays (after the new Triple Click episode is out).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\weekly-update.ps1"
echo.
pause
