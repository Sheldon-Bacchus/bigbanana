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
    taskkill.exe /PID $procId /T /F 2>$null | Out-Null
    Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
    Write-Host "已停止 $name (PID $procId)"
  } else {
    Write-Host "$name 进程不存在，清理 PID 文件"
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

foreach ($port in @(3005, 5173)) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $listenerPid = [int]$listener.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
    $commandLine = $proc.CommandLine
    if ($commandLine -and $commandLine -like "*$root*") {
      taskkill.exe /PID $listenerPid /T /F 2>$null | Out-Null
      Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
      Write-Host "已清理本项目残留进程 (PID $listenerPid, 端口 $port)"
    } else {
      Write-Host "警告：端口 $port 被外部进程 PID $listenerPid 占用，未自动终止；请人工确认。" -ForegroundColor Yellow
    }
  }
}
