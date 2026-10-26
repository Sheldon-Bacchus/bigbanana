# 查看 dev / prod 状态
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root '.run'

$services = @(
  @{ Name = 'prod'; Port = 3005; Health = '/healthz' },
  @{ Name = 'dev'; Port = 5173; Health = '/' }
)

$rows = foreach ($svc in $services) {
  $pidFile = Join-Path $runDir "$($svc.Name).pid"
  $procId = ''
  $processAlive = $false
  if (Test-Path $pidFile) {
    $procId = (Get-Content $pidFile -Raw).Trim()
    if ($procId -match '^\d+$') {
      $processAlive = [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
    }
  }

  $listener = Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $portPid = if ($listener) { $listener.OwningProcess } else { '' }

  $health = 'down'
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($svc.Port)$($svc.Health)" -TimeoutSec 2
    if ($response.StatusCode -ge 200) { $health = "HTTP $($response.StatusCode)" }
  } catch { }

  [pscustomobject]@{
    Service  = $svc.Name
    Port     = $svc.Port
    PID      = $procId
    Alive    = $processAlive
    PortPID  = $portPid
    Health   = $health
    URL      = "http://127.0.0.1:$($svc.Port)"
  }
}

$rows | Format-Table -AutoSize
