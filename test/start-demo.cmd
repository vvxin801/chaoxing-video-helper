@echo off
rem 一键启动本地演示页：起一个静态服务器，并用默认浏览器打开。
setlocal
set PORT=8765
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if "%PY%"=="" (
  where py >nul 2>nul && set PY=py
)
if "%PY%"=="" (
  echo 未找到 Python。请先安装 Python，或用其他静态服务器在本目录提供 http 服务。
  pause
  exit /b 1
)

echo 演示地址: http://127.0.0.1:%PORT%/demo.html?vanDelay=2
echo 请确保已在 edge://extensions 里加载了上一层的 video-auto-next 扩展。
echo 按 Ctrl+C 停止。
start "" "http://127.0.0.1:%PORT%/demo.html?vanDelay=2"
%PY% -m http.server %PORT% --bind 127.0.0.1
