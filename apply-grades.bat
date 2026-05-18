@echo off
title SMGo – Apply Mobile Grades to SuperMemo
cd /d "%~dp0"
echo.
echo ╔══════════════════════════════════════════╗
echo ║  SMGo Grade Applicator                  ║
echo ║  Make sure SuperMemo is OPEN first!     ║
echo ╚══════════════════════════════════════════╝
echo.
GradeApplicator\publish\SMGoApply.exe "%~dp0grades"
pause
