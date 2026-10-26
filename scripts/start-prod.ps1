# 启动生产服务器（固定 3005，静态 dist + 同源代理）
param(
  [int]$Port = 3005,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root '.run'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $runDir, $logDir | Out-Null

$pidFile = Join-Path $runDir 'prod.pid'
$indexFile = Join-Path $root 'dist\index.html'

if (-not (Test-Path $indexFile)) {
  if ($SkipBuild) {
    Write-Error 'dist/index.html 不存在，且指定了 -SkipBuild。'
    exit 1
  }
  Write-Host 'dist 不存在，先执行 npm run build ...'
  Push-Location $root
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }
  } finally {
    Pop-Location
  }
}

if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw).Trim()
  if ($oldPid -match '^\d+$' -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Host "prod 已在运行 (PID $oldPid) -> http://127.0.0.1:$($Port)"
    exit 0
  }
  Remove-Item $pidFile -Force
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Write-Error "端口 $Port 已被占用 (PID $($listener.OwningProcess))，请先 stop 或换端口。"
  exit 1
}

$outLog = Join-Path $logDir 'prod.out.log'
$errLog = Join-Path $logDir 'prod.err.log'
$env:BB_HOST = '127.0.0.1'
$env:BB_PORT = "$Port"

$proc = Start-Process -FilePath 'node' `
  -ArgumentList @('server/prodServer.mjs') `
  -WorkingDirectory $root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru -WindowStyle Hidden

$proc.Id | Set-Content -Path $pidFile -Encoding ascii
Write-Host "启动 prod (PID $($proc.Id)) -> http://127.0.0.1:$Port"

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) { break }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      Write-Host 'prod 就绪。'
      exit 0
    }
  } catch { }
}

Write-Error "prod 启动失败，见 $errLog"
Get-Content $errLog -Tail 30 -ErrorAction SilentlyContinue
exit 1
