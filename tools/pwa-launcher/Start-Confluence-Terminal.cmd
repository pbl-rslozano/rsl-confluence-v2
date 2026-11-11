@echo off
rem rsL Confluence Terminal - local launcher (Windows). Needs Node.js 18+ (https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node serve-pwa.mjs --port 8770 --open-browser
pause
