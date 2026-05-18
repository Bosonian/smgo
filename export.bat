@echo off
title SMGo – Export Today's Cards to GitHub
cd /d "%~dp0"
echo.
echo Exporting today's SuperMemo cards and pushing to GitHub Pages...
echo.
node export.js
echo.
pause
