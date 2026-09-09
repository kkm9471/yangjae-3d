@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   OpenStreetMap 에서 지도 원본을 다시 받습니다.
echo   인터넷이 필요합니다. 무료 공개 서버라 자주 부르면 안 됩니다.
echo.
pause

set PYTHONUTF8=1
python tools/fetch_osm.py --force
if errorlevel 1 goto fail
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
echo   [실패] 인터넷 연결을 확인하고 다시 해 보세요.
pause
exit /b 1

:badcheck
echo.
echo   [주의] 지도는 만들어졌지만 검증에서 문제가 나왔습니다.
echo          위의 [실패] 줄을 그대로 복사해서 물어보세요.
pause
exit /b 1
