@echo off
rem Starts ChatLens locally on http://127.0.0.1:4477 and opens it in the default browser.
cd /d "%~dp0"
start "" http://127.0.0.1:4477
node server.mjs
