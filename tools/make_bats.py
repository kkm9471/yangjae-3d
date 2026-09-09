# -*- coding: utf-8 -*-
"""실행용 .bat 파일들을 만든다.

.bat 은 손으로 고치면 인코딩·따옴표·백슬래시에서 조용히 깨지기 쉬워서,
여기서 한 번에 생성한다. 파일을 고치고 싶으면 이 스크립트를 고치고 다시 실행할 것.
  python tools/make_bats.py
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RUN = """@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PORT=8765

echo.
echo   ============================================
echo     양재역 3D  ·  하루 24시간
echo   ============================================
echo.

where python >nul 2>nul
if errorlevel 1 goto nopython

echo   브라우저를 엽니다.
echo   끄고 싶으면 이 검은 창을 닫으세요.
echo.
start "" /min cmd /c "timeout /t 2 >nul && start http://127.0.0.1:%PORT%/index.html"
python tools/serve.py --stay --verbose
echo.
echo   서버가 멈췄습니다. 포트 %PORT% 를 다른 프로그램이 쓰고 있을 수 있습니다.
pause
exit /b 0

:nopython
echo   [문제] 파이썬을 찾을 수 없습니다.
echo   python.org 에서 설치할 때 "Add python.exe to PATH" 를 켜 주세요.
echo.
pause
exit /b 1
"""

REBUILD = """@echo off
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
"""

REFETCH = """@echo off
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
"""

AUTOSTART = """@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   윈도우를 켤 때 지도 서버를 자동으로 띄울지 바꿉니다.
echo   켜 두면 크롬 즐겨찾기로 바로 들어갈 수 있습니다:
echo       http://127.0.0.1:8765/index.html
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\\autostart.ps1"
echo.
pause
"""

FILES = [
    (["실행.bat", "run.bat"], RUN),
    (["지도다시만들기.bat", "rebuild.bat"], REBUILD),
    (["원본다시받기.bat", "refetch.bat"], REFETCH),
    (["자동시작.bat", "autostart.bat"], AUTOSTART),
]

if __name__ == "__main__":
    for names, text in FILES:
        for n in names:
            with io.open(os.path.join(ROOT, n), "w", encoding="utf-8", newline="\r\n") as f:
                f.write(text)
            print("  wrote", n)
    print("완료")
