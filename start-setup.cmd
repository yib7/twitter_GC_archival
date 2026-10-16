@echo off
rem ===========================================================================
rem  Double-click to set up the Group Chat Archive.
rem  Starts the setup server and opens the setup wizard in your browser.
rem  Needs Node.js 22.13 or newer installed (https://nodejs.org); Node 23 is
rem  not supported. Closing the browser closes this window automatically; the
rem  window only stays open if startup failed.
rem ===========================================================================

rem Started from inside the ZIP (Explorer's zip view): Windows copies just this
rem file to a temp folder, so the other files aren't next to it.
if not exist "%~dp0scripts\server.js" goto :not_extracted

where node >nul 2>nul
if errorlevel 1 goto :no_node

rem "call" so a node.cmd shim (some version managers use one) returns here.
rem Accepts what package.json "engines" admits: 22.13 or a later 22.x, or 24 and newer.
call node -e "var v = process.versions.node.split('.').map(Number); process.exit(v[0] >= 24 ? 0 : v[0] == 22 ? (v[1] >= 13 ? 0 : 1) : 1)" >nul 2>nul
if errorlevel 1 goto :old_node

call node "%~dp0scripts\server.js" --open
if errorlevel 1 pause
exit /b

:not_extracted
echo.
echo   The Group Chat Archive can't start from inside the ZIP file.
echo   Extract it first: right-click the ZIP, choose "Extract All...",
echo   then open the extracted folder and double-click start-setup.cmd there.
echo.
pause
exit /b 1

:no_node
echo.
echo   Node.js isn't installed, or Windows can't find it.
echo   Install the LTS version from https://nodejs.org (it's free), then
echo   double-click start-setup.cmd again.
echo.
pause
exit /b 1

:old_node
echo.
echo   This version of Node.js can't run the Group Chat Archive.
echo   It needs Node.js 22.13 or newer (Node 23 is not supported).
echo   Install the current LTS version from https://nodejs.org, then
echo   double-click start-setup.cmd again.
echo.
pause
exit /b 1
