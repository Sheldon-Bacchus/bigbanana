# 停止 dev / prod（按 .run/*.pid，连同子进程）
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root '.run'

foreach ($name in @('prod', 'dev')) {
  $pidFile = Join-Path $runDir "$name.pid"
  if (-not (Test-Path $pidFile)) {
    Write-Host "$name 未运行（无 PID 文件）"
    continue
  }

  $procId = (Get-Content $pidFile -Raw).Trim()
  if ($procId -match '^\d+$' -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
    taskkill /PID $procId /T /F | Out-Null
    Write-Host "已停止 $name (PID $procId)"
  } else {
    Write-Host "$name 进程不存在，清理 PID 文件"
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

foreach ($port in @(3005, 5173)) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    Write-Host "警告：端口 $port 仍被 PID $($listener.OwningProcess) 占用" -ForegroundColor Yellow
  }
}
