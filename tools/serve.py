# -*- coding: utf-8 -*-
"""화면을 띄우기 위한 작은 웹서버.

왜 그냥 http.server 를 안 쓰나:
  창 없이 띄우면(pythonw) 끄는 방법이 없어서 서버가 계속 살아남는다.
  보이지 않는 채로 계속 도는 프로세스가 제일 위험하다.
  그래서 브라우저 쪽에서 20초마다 신호(/__ping)를 보내고,
  3분 동안 신호가 없으면 서버가 스스로 종료한다.
  (탭을 닫거나, 브라우저를 끄거나, 컴퓨터가 잠들면 자동으로 정리된다)

포트가 이미 쓰이고 있으면: 우리 서버가 이미 떠 있는 것일 수 있으므로 확인만 하고 조용히 끝낸다.
"""
import http.server
import os
import socket
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request

PORT = int(os.environ.get("YANGJAE_PORT", "8765"))
STAY = "--stay" in sys.argv          # 계속 켜 둔다(즐겨찾기·자동시작용)
VERBOSE = "--verbose" in sys.argv    # 검은 창에서 진행 상황을 보여 준다
IDLE_LIMIT = 180.0        # 신호가 이만큼 끊기면 종료(초)
FIRST_WAIT = 90.0         # 브라우저가 뜰 때까지 기다려 주는 시간(초)

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
LOG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "serve.log")

_last = [time.time()]
_seen_browser = [False]


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}\n")
    except Exception:
        pass


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.startswith("/__ping"):
            _last[0] = time.time()
            _seen_browser[0] = True
            self.send_response(204)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        # 코드를 고쳤는데 옛날 것이 그대로 보이는 사고를 막는다
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if VERBOSE:
            print("   " + (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False    # 이미 떠 있으면 실패해야 알 수 있다


def watchdog(httpd):
    if STAY:
        return                     # 자동 종료 안 함
    start = time.time()
    while True:
        time.sleep(3)
        idle = time.time() - _last[0]
        if not _seen_browser[0]:
            if time.time() - start > FIRST_WAIT:
                log("브라우저가 한 번도 안 붙어서 종료")
                httpd.shutdown()
                return
        elif idle > IDLE_LIMIT:
            log(f"{int(idle)}초 동안 신호 없음 → 종료")
            httpd.shutdown()
            return


def already_running():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/index.html", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    if not os.path.isdir(ROOT):
        log(f"web 폴더를 찾을 수 없음: {ROOT}")
        return 2
    try:
        httpd = Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        if already_running():
            log(f"포트 {PORT} 에 이미 서버가 있음 → 그대로 사용")
            return 0
        log(f"포트 {PORT} 를 열 수 없음: {e}")
        return 1

    log(f"시작 (포트 {PORT}){' [계속켜기]' if STAY else ''}")
    if VERBOSE:
        print(f"   서버 시작: http://127.0.0.1:{PORT}/index.html")
        print("   끄려면 이 창을 닫으세요.")
        print("")
    threading.Thread(target=watchdog, args=(httpd,), daemon=True).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        httpd.server_close()
        log("종료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
