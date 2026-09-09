@echo off
setlocal
cd /d "%~dp0"

set PORT=8765

echo.
echo   ============================================
echo     양재역 야경 3D
echo   ============================================
echo.

where python >nul 2>nul
if errorlevel 1 goto nopython

echo   브라우저를 엽니다... (닫으려면 이 검은 창을 닫으세요)
start "" /min cmd /c "timeout /t 2 >nul && start http://127.0.0.1:%PORT%/index.html"
echo.
python -m http.server %PORT% --bind 127.0.0.1 --directory web
echo.
echo   서버가 멈췄습니다. 포트 %PORT% 를 다른 프로그램이 쓰고 있을 수 있습니다.
pause
exit /b 0

:nopython
echo   [문제] 파이썬을 찾을 수 없습니다.
echo   python.org 에서 설치하거나, 설치할 때 "Add to PATH" 를 켜 주세요.
echo.
pause
exit /b 1
