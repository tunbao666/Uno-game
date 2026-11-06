@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo   UNO 公网联机启动器
echo ==========================================
echo.

rem ================= 1. 定位 Node.js =================
set "NODE_DIR="

rem (1) 系统 PATH 里已经配好
for /f "delims=" %%I in ('where node 2^>nul') do (
  if not defined NODE_DIR set "NODE_DIR=%%~dpI"
)
if defined NODE_DIR if "!NODE_DIR:~-1!"=="\" set "NODE_DIR=!NODE_DIR:~0,-1!"

rem (2) WorkBuddy 自带的 Node（本机目前只有这一份）
if not defined NODE_DIR (
  set "WB=%USERPROFILE%\.workbuddy\binaries\node\versions"
  if exist "!WB!\current" (
    for /f "usebackq delims=" %%V in ("!WB!\current") do (
      if exist "!WB!\%%V\node.exe" set "NODE_DIR=!WB!\%%V"
    )
  )
  if not defined NODE_DIR (
    for /d %%D in ("!WB!\*") do (
      if exist "%%D\node.exe" set "NODE_DIR=%%D"
    )
  )
)

rem (3) 常见安装位置
if not defined NODE_DIR if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
if not defined NODE_DIR if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs"
if not defined NODE_DIR if exist "%LOCALAPPDATA%\nvm" (
  for /d %%D in ("%LOCALAPPDATA%\nvm\v*") do (
    if exist "%%D\node.exe" set "NODE_DIR=%%D"
  )
)

if not defined NODE_DIR (
  echo [错误] 没找到 Node.js。
  echo.
  echo 这个游戏需要 Node.js 才能运行，装一次以后就一直能用：
  echo   方式一：打开 https://nodejs.org/zh-cn 下载 LTS 版，一路「下一步」
  echo   方式二：在 PowerShell 里执行  winget install OpenJS.NodeJS.LTS
  echo.
  echo 装完后关掉这个窗口，重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

set "PATH=!NODE_DIR!;!PATH!"
echo [OK] Node.js: !NODE_DIR!

rem ================= 2. 定位 cloudflared =================
set "CF="
for /f "delims=" %%I in ('where cloudflared 2^>nul') do (
  if not defined CF set "CF=%%I"
)
if not defined CF (
  if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" (
    set "CF=C:\Program Files (x86)\cloudflared\cloudflared.exe"
  ) else if exist "C:\Program Files\cloudflared\cloudflared.exe" (
    set "CF=C:\Program Files\cloudflared\cloudflared.exe"
  )
)

if not defined CF (
  echo [错误] 没找到 cloudflared，请先执行：
  echo        winget install --id Cloudflare.cloudflared
  echo.
  pause
  exit /b 1
)
echo [OK] cloudflared: !CF!

rem ---- 自检模式：只探测环境，不启动服务 ----
if /i "%~1"=="--check" (
  echo.
  for /f "delims=" %%V in ('node -v 2^>nul') do echo [check] node 版本: %%V
  echo [check] 环境探测通过。
  exit /b 0
)

rem ================= 3. 启动 =================
set "PORT_BUSY="
for /f "delims=" %%L in ('netstat -ano ^| findstr /c:":3000 " ^| findstr /c:"LISTENING"') do set "PORT_BUSY=1"
if defined PORT_BUSY (
  echo.
  echo [提示] 端口 3000 已被占用，可能上次的「UNO 服务」窗口还开着。
  echo        可以直接打开 http://localhost:3000 ；想重开请先关掉旧窗口。
)

echo.
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
