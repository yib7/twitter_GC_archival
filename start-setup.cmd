@echo off
rem ===========================================================================
rem  Double-click to set up the Group Chat Archive.
rem  Starts the local server and opens the setup wizard in your browser.
rem  Needs Node.js 18 or newer installed (https://nodejs.org). Closing the
rem  browser closes this window automatically; the window only stays open if
rem  startup failed.
rem ===========================================================================

rem Run from inside the ZIP (Explorer's zip view), Windows copies just this
rem file to a temp folder, so the rest of the app isn't next to it.
if not exist "%~dp0scripts\server.js" goto :not_extracted

where node >nul 2>nul
if errorlevel 1 goto :no_node

rem "call" so a node.cmd shim (some version managers use one) returns here.
call node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>nul
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
echo   Install the LTS version from https://nodejs.org - it's free - then
echo   double-click start-setup.cmd again.
echo.
pause
exit /b 1

:old_node
echo.
echo   Your Node.js is too old for the Group Chat Archive: it needs version 18 or newer.
echo   Install the current LTS version from https://nodejs.org, then
echo   double-click start-setup.cmd again.
echo.
pause
exit /b 1
