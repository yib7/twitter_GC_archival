@echo off
rem ===========================================================================
rem  Double-click to set up the Group Chat Archive.
rem  Starts the local server and opens the setup wizard in your browser.
rem  Needs Node.js installed (https://nodejs.org). Close this window to stop.
rem ===========================================================================
node "%~dp0scripts\server.js" --open
pause
