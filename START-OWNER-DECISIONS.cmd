@echo off
setlocal
title InPlace - Owner Decisions
cd /d "%~dp0"
node scripts\owner-decisions-server.mjs --open
if errorlevel 1 (
  echo.
  echo The decision center could not start. Keep this window open and send its message to the agent.
  pause
)
