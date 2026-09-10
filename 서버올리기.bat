@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0server"

echo.
echo   ================================================
echo    같이 돌아다니기 서버를 올립니다 (무료)
echo   ================================================
echo.
echo   처음 한 번만 Cloudflare 로그인이 필요합니다.
echo   브라우저가 열리면 [Allow] 를 누르세요.
echo   (계정이 없으면 무료로 가입하면 됩니다. 카드 등록 안 합니다)
echo.
pause

call npx wrangler whoami >nul 2>&1
if errorlevel 1 goto dologin
call npx wrangler whoami 2>&1 | findstr /C:"not authenticated" >nul
if not errorlevel 1 goto dologin
goto deploy

:dologin
echo.
echo   [1/2] 로그인 창을 엽니다...
call npx wrangler login
if errorlevel 1 goto fail

:deploy
echo.
echo   [2/2] 서버를 올립니다...
call node deploy.mjs
if errorlevel 1 goto fail

echo.
echo   끝났습니다.
echo   위에 적힌 git 명령을 실행하면 웹에도 반영됩니다.
echo.
pause
exit /b 0

:fail
echo.
echo   [실패] 위 메시지를 그대로 복사해서 물어보세요.
pause
exit /b 1
