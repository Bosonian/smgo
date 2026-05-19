@echo off
title SMGo – Apply Mobile Extracts to SuperMemo
cd /d "%~dp0"
echo.
echo ╔══════════════════════════════════════════╗
echo ║  SMGo Extract Applicator                ║
echo ║  Make sure SuperMemo is OPEN first!     ║
echo ╚══════════════════════════════════════════╝
echo.
GradeApplicator\publish\SMGoApply.exe --extracts "%~dp0extracts"
pause
