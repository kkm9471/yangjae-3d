@echo off
setlocal
cd /d "%~dp0"

echo.
echo   지도를 다시 만듭니다.
echo   (인터넷에서 새로 받지 않고, 이미 받아둔 원본으로 다시 만듭니다)
echo.

set PYTHONUTF8=1
python tools\build_scene.py
echo.
echo   끝났습니다. 실행.bat 을 다시 여세요.
pause
