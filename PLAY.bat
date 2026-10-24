@echo off
rem Ultracraft - double-click launcher (Windows).
rem Starts the bundled static server and opens the game. If Node.js is missing
rem it opens Ultracraft.html, the single-file build, which needs nothing.
cd /d "%~dp0"

echo.
echo   ULTRACRAFT
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js not found - opening the single-file build instead.
  echo   ^(Install Node from https://nodejs.org for the full version.^)
  echo.
  start "" "Ultracraft.html"
  exit /b 0
)

start "" "http://localhost:8080/"
echo   Ultracraft is running at http://localhost:8080/
echo   Close this window to stop the server.
echo.
node tools\serve.js 8080
