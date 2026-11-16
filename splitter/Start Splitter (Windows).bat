@echo off
title Stem Splitter
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found.
  echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH" in the installer.
  echo Then double-click this file again.
  pause
  exit /b 1
)

if not exist ".venv\installed.txt" (
  echo First run: setting things up. This takes several minutes and only happens once.
  echo.
  python -m venv .venv || goto :failed
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :failed
  echo ok > ".venv\installed.txt"
)

echo.
echo Starting Stem Splitter. Keep this window open while you use it. Close it to stop.
echo.
".venv\Scripts\python.exe" server.py --open
pause
exit /b 0

:failed
echo.
echo Setup did not finish. Copy the messages above and send them to whoever is helping you.
pause
exit /b 1
