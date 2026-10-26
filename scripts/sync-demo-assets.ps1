# 从归档恢复大文件 demo.json 与 sproj_mtrxsuxg_bba7_export.json 到 public/
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$archivePublic = 'E:\all-agent-workspace\archive\legacy-agv-root-20260916\apps\bigbanana-ai-director\public'
$targetPublic = Join-Path $root 'public'

if (-not (Test-Path $targetPublic)) {
  New-Item -ItemType Directory -Force -Path $targetPublic | Out-Null
}

$files = @(
  'demo.json',
  'sproj_mtrxsuxg_bba7_export.json'
)

Write-Host "开始同步演示大资源到 $targetPublic ..."

foreach ($file in $files) {
  $srcPath = Join-Path $archivePublic $file
  $dstPath = Join-Path $targetPublic $file

  if (-not (Test-Path $srcPath)) {
    Write-Error "归档文件不存在: $srcPath"
    exit 1
  }

  $srcItem = Get-Item $srcPath
  if ($srcItem.Length -le 0) {
    Write-Error "归档文件大小异常 ($($srcItem.Length) 字节): $srcPath"
    exit 1
  }

  if (Test-Path $dstPath) {
    $dstItem = Get-Item $dstPath
    if ($dstItem.Length -eq $srcItem.Length) {
      Write-Host "[$file] 目标已存在且大小一致 ($($dstItem.Length) 字节)，跳过。"
      continue
    } else {
      Write-Host "[$file] 目标存在但大小不一致 (目标: $($dstItem.Length)，源: $($srcItem.Length))，重新复制..."
    }
  }

  Write-Host "[$file] 正在从归档复制 ($($srcItem.Length) 字节) ..."
  Copy-Item -Path $srcPath -Destination $dstPath -Force

  $copiedItem = Get-Item $dstPath
  if ($copiedItem.Length -ne $srcItem.Length) {
    Write-Error "[$file] 复制后大小不匹配！源: $($srcItem.Length)，目标: $($copiedItem.Length)"
    exit 1
  }
  Write-Host "[$file] 复制成功 ($($copiedItem.Length) 字节)。"
}

Write-Host '全部演示大资源同步完成。'
exit 0
