@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装皮肤.ps1"
if errorlevel 1 (
  echo.
  echo 安装失败，请查看上方错误信息。
  pause
)
