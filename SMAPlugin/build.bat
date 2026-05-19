@echo off
title SMGo – Build SMA Plugin
echo Building SuperMemoAssistant.Plugins.SMGo...
dotnet build "%~dp0SuperMemoAssistant.Plugins.SMGo.csproj" -c Release
if %ERRORLEVEL% == 0 (
  echo.
  echo Build OK – plugin deployed to %%USERPROFILE%%\SuperMemoAssistant\Plugins\Development\
) else (
  echo Build FAILED.
)
pause
