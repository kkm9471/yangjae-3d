@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   윈도우를 켤 때 지도 서버를 자동으로 띄울지 바꿉니다.
echo   켜 두면 크롬 즐겨찾기로 바로 들어갈 수 있습니다:
echo       http://127.0.0.1:8765/index.html
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\autostart.ps1"
echo.
pause
