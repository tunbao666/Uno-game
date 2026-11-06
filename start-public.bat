@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo   UNO 公网联机启动器
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 node，请确认已安装 Node.js
  pause
  exit /b 1
)

set "CF="
where cloudflared >nul 2>nul
if not errorlevel 1 (
  set "CF=cloudflared"
) else (
  if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" (
    set "CF=C:\Program Files (x86)\cloudflared\cloudflared.exe"
  ) else if exist "C:\Program Files\cloudflared\cloudflared.exe" (
    set "CF=C:\Program Files\cloudflared\cloudflared.exe"
  )
)

if "%CF%"=="" (
  echo [错误] 没找到 cloudflared，请先执行：
  echo        winget install --id Cloudflare.cloudflared
  pause
  exit /b 1
)

echo [1/3] 启动游戏服务（端口 3000）...
start "UNO 服务" cmd /k "node server\index.js"
timeout /t 3 >nul

echo [2/3] 建立公网隧道...
start "UNO 隧道" cmd /k ""%CF%" tunnel --url http://localhost:3000 --no-autoupdate"
timeout /t 8 >nul

echo [3/3] 打开本地页面...
start "" "http://localhost:3000"

echo.
echo ------------------------------------------
echo  已启动。看那个标题为「UNO 隧道」的窗口，
echo  里面有一行：
echo.
echo    https://xxxx-xxxx-xxxx.trycloudflare.com
echo.
echo  那就是发给朋友的链接。
echo ------------------------------------------
echo.
echo 注意：这两个窗口都不能关，关掉链接就失效。
echo.
pause
