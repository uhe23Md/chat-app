@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  One-click launcher: local chat server + Cloudflare tunnel
REM
REM  Double-click this file. It will:
REM    1) start the chat server on localhost:3000
REM    2) open a temporary Cloudflare tunnel and get a public URL
REM    3) verify the public URL can really chat over WebSocket
REM
REM  Closing this window kills the public URL.
REM
REM  ------------------------------------------------------------
REM  PITFALLS - all found by actually running it, do NOT revert:
REM
REM  1) NEVER put non-ASCII characters in REM comments here.
REM     cmd.exe parses the whole .bat with the system codepage (GBK on
REM     this machine), so UTF-8 Chinese bytes get mis-split and the
REM     trailing bytes swallow following chars (quotes/newlines).
REM     Result: broken comments leak out as bogus commands like
REM     "'xxx' is not recognized as an internal or external command".
REM     Chinese is fine inside echo (chcp 65001 handles that), but NOT
REM     in comments, labels, or file paths used in commands.
REM
REM  2) Do NOT add a UTF-8 BOM to this file. cmd treats the BOM as part
REM     of the first command, so "@echo off" fails and every line echoes.
REM
REM  3) Do NOT use "timeout /t" for delays. On machines with Git Bash /
REM     MSYS installed, a Unix "timeout" shadows it and the loop dies
REM     with "invalid time interval '/t'". Use ping instead.
REM
REM  4) Subroutines MUST live at the end of the file. Batch executes
REM     top-to-bottom; a call into a mid-file label falls through and
REM     hits "exit /b" early, silently skipping everything after it.
REM
REM  5) Start the tunnel via PowerShell's Start-Process, not "start".
REM     "start" with nested quotes plus redirection is fragile and the
REM     log file often ends up empty.
REM  ------------------------------------------------------------

cd /d "%~dp0"

echo.
echo ============================================================
echo   正在启动聊天室 + 公网隧道
echo ============================================================
echo.

REM ---- Step 1: start the chat server ----
echo [1/3] 启动聊天室服务...
start "聊天室服务" /min cmd /c "npm start"

call :wait_http http://localhost:3000/api/health 25
if errorlevel 1 (
  echo.
  echo [X] 服务启动超时（25 秒）。
  echo     请在新窗口手动执行 npm start，看看报什么错。
  pause
  exit /b 1
)
echo       服务已就绪（http://localhost:3000）
echo.

REM ---- Step 2: build the Cloudflare tunnel ----
echo [2/3] 正在建立公网隧道...
echo       需要连接 Cloudflare，大约 5-15 秒。
echo.

set "CLOUDFLARED=%LOCALAPPDATA%\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED%" (
  echo [X] 没找到 cloudflared：
  echo     %CLOUDFLARED%
  echo.
  echo     下载地址（单文件，下载后放到上面那个位置）：
  echo     https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  pause
  exit /b 1
)

set "TUNNEL_LOG=%TEMP%\chat-tunnel.log"
REM Truncate instead of delete: a previous cloudflared may still hold the
REM handle, and "del" then fails with "The process cannot access the file".
REM Kill any leftover tunnel first so the old URL really is dead.
taskkill /f /im cloudflared.exe >nul 2>&1
> "%TUNNEL_LOG%" echo.
> "%TUNNEL_LOG%.err" echo.

REM Launch detached via PowerShell so the log file actually gets written
powershell -NoProfile -Command "Start-Process -FilePath '%CLOUDFLARED%' -ArgumentList 'tunnel','--no-autoupdate','--url','http://localhost:3000' -WindowStyle Hidden -RedirectStandardOutput '%TUNNEL_LOG%' -RedirectStandardError '%TUNNEL_LOG%.err'"

call :wait_tunnel 40
if errorlevel 1 (
  echo [X] 隧道建立超时。日志内容：
  echo ------------------------------------------------------------
  if exist "%TUNNEL_LOG%" type "%TUNNEL_LOG%"
  if exist "%TUNNEL_LOG%.err" type "%TUNNEL_LOG%.err"
  echo ------------------------------------------------------------
  pause
  exit /b 1
)

REM Extract the public URL (logic lives in :pick_url at the end).
REM Search ONLY the .err file: findstr prefixes each hit with
REM "filename:" when given more than one file, which would poison RAWLINE.
REM cloudflared writes its log to stderr, so stdout is normally empty.
set "PUBLIC_URL="
for /f "usebackq tokens=*" %%u in (`findstr /R /C:"https://[a-z0-9-]*\.trycloudflare\.com" "%TUNNEL_LOG%.err"`) do (
  set "RAWLINE=%%u"
  call :pick_url
)

if "%PUBLIC_URL%"=="" (
  echo [X] 没能从日志里解析出公网地址。日志内容：
  if exist "%TUNNEL_LOG%" type "%TUNNEL_LOG%"
  if exist "%TUNNEL_LOG%.err" type "%TUNNEL_LOG%.err"
  pause
  exit /b 1
)

echo       公网地址已拿到。
echo.

REM Wait until DNS actually resolves this hostname.
REM Why nslookup instead of curl: right after creation the hostname is not
REM yet served by Cloudflare's edge, so DNS answers NXDOMAIN. curl returns
REM a connection error that looks identical to "tunnel is broken". Probing
REM DNS separately tells us plainly when it is safe to start verifying.
echo       等待公网地址生效（DNS 生效通常需要几秒）...
call :wait_dns %PUBLIC_URL% 60
if errorlevel 1 (
  powershell -NoProfile -Command "Write-Host '      [警告] DNS 还没生效，仍然尝试验证（可能失败）。'"
)
echo.

REM ---- Step 3: verify the public URL really works ----
powershell -NoProfile -Command "Write-Host '[3/3] 正在验证公网地址（含 WebSocket 实时收发）...'"
echo.
node deploy\verify-tunnel.cjs %PUBLIC_URL%

echo.
echo ============================================================
powershell -NoProfile -Command "Write-Host '  这个链接可以发给别人了（手机、其他电脑都能打开）：'"
echo.
echo   %PUBLIC_URL%
echo.
powershell -NoProfile -Command "Write-Host '  注意：关掉本窗口或关机后，链接就失效了。'; Write-Host '  下次双击本文件会拿到一个新地址。'"
echo ============================================================
echo.

> "%USERPROFILE%\Desktop\聊天室公网地址.txt" echo %PUBLIC_URL%
echo 地址已同时存到桌面「聊天室公网地址.txt」
echo.
echo 按任意键关闭本窗口（公网地址会随之失效）...
pause >nul
exit /b 0


REM ============================================================
REM  Subroutines - must stay at the very end of the file
REM ============================================================

REM Poll DNS until the hostname resolves. %1=full url %2=max seconds.
REM nslookup prints "Address:" lines on success and "can't find" on failure.
:wait_dns
set "HOST=%~1"
REM strip the scheme so nslookup gets a bare hostname
set "HOST=%HOST:https://=%"
set /a _D=0
:wait_dns_loop
call :sleep_short
nslookup %HOST% >nul 2>&1
if not errorlevel 1 exit /b 0
set /a _D+=1
set /a _MAXD=%2*5/2
if %_D% lss %_MAXD% goto wait_dns_loop
exit /b 1

REM Poll an HTTP endpoint until it answers. %1=url %2=max seconds.
REM Returns 0 on success, 1 on timeout.
REM Sleeps ~0.4s between tries (ping -n 1 is roughly 400ms) so DNS
REM propagation is picked up quickly instead of in 1s steps.
:wait_http
set /a _W=0
:wait_http_loop
call :sleep_short
set /a _W+=1
curl -s -o nul --max-time 4 %1
if not errorlevel 1 exit /b 0
REM %2 seconds / 0.4s per tick  ~= %2 * 2.5 attempts
set /a _MAXTRIES=%2*2
if %_W% lss %_MAXTRIES% goto wait_http_loop
exit /b 1

REM Sleep roughly 0.4 second using ping. See pitfall 3 in the header:
REM "timeout /t" breaks on machines that have a Unix timeout on PATH.
:sleep_short
ping -n 1 -w 200 127.0.0.1 >nul 2>&1
exit /b 0

REM Poll the tunnel log until a real public URL shows up. %1=max seconds.
REM IMPORTANT: match the actual URL pattern, not just "trycloudflare.com".
REM The banner text ("Requesting new quick Tunnel on trycloudflare.com...")
REM contains that string too, so a loose match exits on the banner and we
REM parse an empty URL. Search only the .err file (stdout stays empty for
REM cloudflared on Windows; everything goes to stderr).
:wait_tunnel
set /a _T=0
:wait_tunnel_loop
call :sleep_short
set /a _T+=1
findstr /R /C:"https://[a-z0-9-]*\.trycloudflare\.com" "%TUNNEL_LOG%.err" >nul 2>&1
if not errorlevel 1 exit /b 0
REM ~0.4s per tick, so multiply the requested seconds by 2.5
set /a _MAXT=%1*5/2
if %_T% lss %_MAXT% goto wait_tunnel_loop
exit /b 1

REM Pull https://xxx.trycloudflare.com out of RAWLINE.
REM The log line looks like:
REM   2026-09-16T14:20:03Z INF |  https://xxx.trycloudflare.com  |
REM Splitting on spaces would need the 3rd token, but
REM "for %%t in (string)" does NOT split on spaces, so instead we do
REM plain string replacement: chop everything before https://, then
REM delete spaces and pipes, and finally re-check the prefix.
:pick_url
setlocal enabledelayedexpansion
set "TMP=!RAWLINE:*https://=https://!"
set "TMP=!TMP: =!"
set "TMP=!TMP:|=!"
if "!TMP:~0,8!"=="https://" (
  endlocal & set "PUBLIC_URL=%TMP%"
) else (
  endlocal
)
exit /b 0
