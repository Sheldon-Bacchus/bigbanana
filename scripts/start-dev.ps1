# 启动开发服务器（固定 5173，strictPort）
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root '.run'
$logDir = Join-Path $root 'logs'
$tempDir = Join-Path $root '.tmp'
New-Item -ItemType Directory -Force -Path $runDir, $logDir, $tempDir | Out-Null

# esbuild 在系统 Temp 下可能因 ACL/占用无法删除临时文件；dev 统一使用项目内 .tmp
$env:TEMP = $tempDir
$env:TMP = $tempDir

$port = 5173
$pidFile = Join-Path $runDir 'dev.pid'

if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw).Trim()
  if ($oldPid -match '^\d+$' -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Host "dev 已在运行 (PID $oldPid) -> http://127.0.0.1:$port"
    exit 0
  }
  Remove-Item $pidFile -Force
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Write-Error "端口 $port 已被占用 (PID $($listener.OwningProcess))，请先 stop 或换端口。"
  exit 1
}

$viteBin = Join-Path $root 'node_modules\vite\bin\vite.js'
if (-not (Test-Path $viteBin)) {
  Write-Error '未安装依赖：请先在本目录执行 npm install。'
  exit 1
}

$outLog = Join-Path $logDir 'dev.out.log'
$errLog = Join-Path $logDir 'dev.err.log'
$proc = Start-Process -FilePath 'node' `
  -ArgumentList @($viteBin, '--host', '127.0.0.1', '--port', '5173', '--strictPort') `
  -WorkingDirectory $root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru -WindowStyle Hidden

$proc.Id | Set-Content -Path $pidFile -Encoding ascii
Write-Host "启动 dev (PID $($proc.Id)) -> http://127.0.0.1:$port"

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) { break }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 2
    if ($response.StatusCode -ge 200) {
      Write-Host 'dev 就绪。'
      exit 0
    }
  } catch { }
}

Write-Error "dev 启动失败，见 $errLog"
Get-Content $errLog -Tail 30 -ErrorAction SilentlyContinue
exit 1
