@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0server"

echo.
echo   ================================================
echo    같이 돌아다니기 서버를 올립니다 (무료)
echo   ================================================
echo.

call npx wrangler whoami 2>&1 | findstr /C:"not authenticated" >nul
if errorlevel 1 goto deploy

echo   처음 한 번만 Cloudflare 로그인이 필요합니다.
echo   브라우저가 열리면 [Allow] 를 누르세요.
echo.
pause
call npx wrangler login
if errorlevel 1 goto fail

:deploy
call node deploy.mjs
if errorlevel 1 goto fail

cd /d "%~dp0"
echo.
echo   웹에 반영하는 중...
git add web/data/net.json
git commit -m "실시간 서버 주소" >nul 2>&1
git push -q origin main
if errorlevel 1 goto pushfail

echo.
echo   ================================================
echo    끝났습니다.
echo    1~2분 뒤부터 아래 주소에서 같이 돌아다닐 수 있습니다.
echo.
echo      https://kkm9471.github.io/yangjae-3d/
echo   ================================================
echo.
pause
exit /b 0

:pushfail
echo.
echo   [주의] 서버는 올라갔는데 웹 반영(git push)이 실패했습니다.
echo          인터넷 연결을 확인하고 다시 실행해 보세요.
pause
exit /b 1

:fail
echo.
echo   [실패] 위 메시지를 그대로 복사해서 물어보세요.
pause
exit /b 1
