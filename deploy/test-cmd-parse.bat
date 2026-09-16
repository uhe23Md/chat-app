@echo off
REM Cmd-syntax edge case tests for the launcher's URL parsing. Pure ASCII.
REM Kept in repo as a regression test - run via: npm run test:launcher
setlocal enabledelayedexpansion

set "TUNNEL_LOG=%TEMP%\chat-url-parse-test.log"
set /a PASSED=0
set /a FAILED=0

REM ---- CASE A: multiple URLs in log -> should take the LAST one ----
echo 2026-09-16T14:20:01Z INF ^| https://old-tunnel-aaa.trycloudflare.com ^| > "%TUNNEL_LOG%"
echo 2026-09-16T14:20:09Z INF ^| https://new-tunnel-bbb.trycloudflare.com ^| >> "%TUNNEL_LOG%"
set "PUBLIC_URL="
for /f "usebackq tokens=*" %%u in (`findstr /R /C:"https://[a-z0-9-]*\.trycloudflare\.com" "%TUNNEL_LOG%"`) do (
  set "RAWLINE=%%u"
  call :pick_url
)
if "%PUBLIC_URL%"=="https://new-tunnel-bbb.trycloudflare.com" (
  echo   PASS  latest URL taken  [%PUBLIC_URL%]
  set /a PASSED+=1
) else (
  echo   FAIL  latest URL taken  got=[%PUBLIC_URL%]
  set /a FAILED+=1
)

REM ---- CASE B: no pipe decoration, plain line ----
echo 2026-09-16T14:20:01Z INF https://plain-format-ccc.trycloudflare.com > "%TUNNEL_LOG%"
set "PUBLIC_URL="
for /f "usebackq tokens=*" %%u in (`findstr /R /C:"https://[a-z0-9-]*\.trycloudflare\.com" "%TUNNEL_LOG%"`) do (
  set "RAWLINE=%%u"
  call :pick_url
)
if "%PUBLIC_URL%"=="https://plain-format-ccc.trycloudflare.com" (
  echo   PASS  plain format works  [%PUBLIC_URL%]
  set /a PASSED+=1
) else (
  echo   FAIL  plain format works  got=[%PUBLIC_URL%]
  set /a FAILED+=1
)

REM ---- CASE C: URL at very start of line ----
echo https://at-line-start-ddd.trycloudflare.com > "%TUNNEL_LOG%"
set "PUBLIC_URL="
for /f "usebackq tokens=*" %%u in (`findstr /R /C:"https://[a-z0-9-]*\.trycloudflare\.com" "%TUNNEL_LOG%"`) do (
  set "RAWLINE=%%u"
  call :pick_url
)
if "%PUBLIC_URL%"=="https://at-line-start-ddd.trycloudflare.com" (
  echo   PASS  line-start format works  [%PUBLIC_URL%]
  set /a PASSED+=1
) else (
  echo   FAIL  line-start format works  got=[%PUBLIC_URL%]
  set /a FAILED+=1
)

REM ---- CASE D: metrics line should NOT yield a tunnel URL ----
echo 2026-09-16T14:20:04Z INF Starting metrics server on 127.0.0.1:20241/metrics > "%TUNNEL_LOG%"
set "PUBLIC_URL="
for /f "usebackq tokens=*" %%u in (`findstr /R /C:"https://[a-z0-9-]*\.trycloudflare\.com" "%TUNNEL_LOG%"`) do (
  set "RAWLINE=%%u"
  call :pick_url
)
if "%PUBLIC_URL%"=="" (
  echo   PASS  metrics line not matched
  set /a PASSED+=1
) else (
  echo   FAIL  metrics was wrongly matched=[%PUBLIC_URL%]
  set /a FAILED+=1
)

del "%TUNNEL_LOG%" >nul 2>&1
echo.
echo ============================================================
echo   cmd syntax edge cases: %PASSED% passed, %FAILED% failed
echo ============================================================
if %FAILED% gtr 0 exit /b 1
goto :eof

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
goto :eof
