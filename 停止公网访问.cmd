@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  Stop public access: kill the chat server and the tunnel.
REM
REM  Double-click this and the public URL dies immediately.
REM  To bring it back, double-click the launcher (qi-dong-gong-wang-fang-wen.cmd) again.
REM
REM  NOTE: comments in this file are ASCII-only on purpose.
REM  cmd.exe reads .bat files with the system codepage, so Chinese
REM  bytes in REM lines get mis-split and leak out as bogus commands.
REM  Chinese inside echo is fine (chcp 65001 handles it).
REM ============================================================

echo.
echo 正在停止...

taskkill /f /im cloudflared.exe >nul 2>&1
if errorlevel 1 (
  echo   隧道进程：没在跑
) else (
  echo   隧道进程：已停止
)

REM Kill by window title so we do not touch your other node processes
taskkill /f /fi "WINDOWTITLE eq 聊天室服务*" >nul 2>&1
if errorlevel 1 (
  echo   聊天室服务窗口：没找到（可能已关掉）
) else (
  echo   聊天室服务窗口：已停止
)

echo.
echo 完成。公网地址已经失效了。
echo.
echo 按任意键关闭...
pause >nul
