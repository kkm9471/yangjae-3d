@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   지도를 다시 만듭니다.
echo   (인터넷에서 새로 받지 않고, 이미 받아둔 원본으로 다시 만듭니다)
echo.

set PYTHONUTF8=1
python tools/build_scene.py
if errorlevel 1 goto fail
echo.
echo   ---- 검증 17항목 ----
python tests/verify.py
if errorlevel 1 goto badcheck
echo.
echo   끝났습니다. 실행.bat 을 다시 여세요.
pause
exit /b 0

:fail
echo.
echo   [실패] 지도를 만들지 못했습니다. 위 메시지를 확인하세요.
pause
exit /b 1

:badcheck
echo.
echo   [주의] 지도는 만들어졌지만 검증에서 문제가 나왔습니다.
echo          위의 [실패] 줄을 그대로 복사해서 물어보세요.
pause
exit /b 1
