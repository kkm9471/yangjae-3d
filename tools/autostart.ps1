# 윈도우 시작프로그램에 지도 서버를 넣었다 뺐다 한다 (토글).
# 켜 두면 크롬 즐겨찾기( http://127.0.0.1:8765/index.html )로 바로 들어갈 수 있다.
# 끄면 '실행(창없이).vbs' 를 두 번 클릭할 때만 서버가 뜬다.

$ErrorActionPreference = 'Stop'
$proj    = Split-Path -Parent $PSScriptRoot
$vbs     = Join-Path $proj '실행(창없이).vbs'
$startup = [Environment]::GetFolderPath('Startup')
$link    = Join-Path $startup '양재역3D 지도서버.lnk'

if (-not (Test-Path $vbs)) {
  Write-Host "  [문제] 실행(창없이).vbs 를 찾을 수 없습니다: $vbs"
  exit 1
}

if (Test-Path $link) {
  Remove-Item $link -Force
  Write-Host "  자동시작을 껐습니다."
  Write-Host ""
  Write-Host "  이제 지도를 보려면 '실행(창없이).vbs' 를 두 번 클릭하세요."
  Write-Host "  (지금 켜져 있는 서버는 브라우저를 닫으면 3분 뒤 스스로 꺼집니다)"
} else {
  $sh = New-Object -ComObject WScript.Shell
  $s  = $sh.CreateShortcut($link)
  $s.TargetPath       = 'wscript.exe'
  $s.Arguments        = '"' + $vbs + '" stay'
  $s.WorkingDirectory = $proj
  $s.Description      = '양재역 3D 지도 서버 (localhost 8765)'
  $s.Save()
  Write-Host "  자동시작을 켰습니다."
  Write-Host ""
  Write-Host "  크롬 즐겨찾기에 이 주소를 넣으세요:"
  Write-Host "      http://127.0.0.1:8765/index.html"
  Write-Host ""
  Write-Host "  다음에 컴퓨터를 켜면 서버가 저절로 뜹니다."
  Write-Host "  지금 바로 쓰려면 '실행(창없이).vbs' 를 한 번 두 번 클릭해 두세요."
  Write-Host "  (창은 안 뜹니다. 메모리 약 20MB, 바깥에서는 접속 불가)"
}
