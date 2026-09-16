@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  Tunnel console: run the tunnel in the foreground and watch
REM  its live log. Handy for seeing whether anyone is visiting.
REM
REM  The free tunnel works fine without this; it is purely for
REM  troubleshooting. Ctrl+C stops it.
REM
REM  NOTE: comments are ASCII-only on purpose, see the main launcher script
REM  for the full explanation of the cmd.exe codepage pitfall.
REM ============================================================

set "CLOUDFLARED=%LOCALAPPDATA%\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED%" (
  echo [X] 没找到 cloudflared：
  echo     %CLOUDFLARED%
  pause
  exit /b 1
)

echo ============================================================
echo   正在建立隧道并实时显示日志
echo   （按 Ctrl+C 停止，公网地址也会随之失效）
echo ============================================================
echo.

REM Run in the foreground so the log streams right here
"%CLOUDFLARED%" tunnel --no-autoupdate --url http://localhost:3000

pause >nul
