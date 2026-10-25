# Baseline — BigBanana AI Director 归档快照

本仓库的初始源码来自归档快照，不包含上游 git 历史。

| 项 | 值 |
|---|---|
| 来源目录 | `E:\all-agent-workspace\archive\legacy-agv-root-20260916\apps\bigbanana-ai-director` |
| 归档仓库提交 | `09ea5ef012b8ea3080389605d0651de9bae07f57` |
| 归档提交时间 | 2026-09-09 20:54:46 +08:00 |
| 导入时间 | 2026-10-25 |
| 文件数 | 279（不含排除项） |
| 体积 | 约 26.6 MB |
| 许可证 | CC BY-NC-SA 4.0（见 LICENSE / NOTICE） |

## 排除项（未复制）

- `.git/`（归档根目录自身是一个 git 仓库）
- `node_modules/`、`dist/`
- `.claude/`
- `Dockerfile*`、`docker-compose.yaml`、`nginx.conf`、`docker使用.md`
- `public/demo.json`、`public/sproj_mtrxsuxg_bba7_export.json`（各约 102 MB，仅
  `public/auto-import.html` 的可选 demo 使用；用 `scripts/sync-demo-assets.ps1` 按需恢复）

## 完整性校验

`baseline-manifest.sha256` 记录了导入时每个基线文件的 SHA256（相对路径），
可用于确认当前仓库的基线文件未被意外改动：

```powershell
Get-Content baseline-manifest.sha256 | ForEach-Object {
  $hash, $path = $_ -split ' \*', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower()
  if ($actual -ne $hash) { Write-Output "MISMATCH $path" }
}
```

新增的产品文件（README、NOTICE、BASELINE、脚本、后续源码）不在清单内。
