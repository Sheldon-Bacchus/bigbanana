# BigBanana Fork Studio

> 基于 BigBanana AI Director 的个人/非商业衍生工作室
> 四阶段导演工作台 + 可生成画布 + 导演台双向互通（规划中）

## 来源与许可

- 上游：**BigBanana AI Director**（归档快照，提交 `09ea5ef0`）
- 许可证：**CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享）
- 上游说明：见 [`README.upstream.md`](./README.upstream.md)、[`NOTICE`](./NOTICE)、[`BASELINE.md`](./BASELINE.md)
- 本仓库仅用于个人、非商业用途；不得删除署名或默认 `api.antsk.cn` 端点。

## 数据权威（重要）

作品数据保存在浏览器的 **IndexedDB（BigBananaDB）与 OPFS**，绑定 origin：

| 用途 | Origin | 说明 |
|---|---|---|
| 正式使用 | `http://127.0.0.1:3005` | 正式数据只在这里产生与保存 |
| 开发调试 | `http://127.0.0.1:5173` | 独立数据库，不承载正式作品 |

> 换端口、换域名、换浏览器 = 看不到旧数据。请固定正式 origin，并定期用应用内
> 「导出 JSON」备份；视频文件在 OPFS 中，受浏览器配额限制。

## 快速开始

前置：Node.js ≥ 22、npm。

```powershell
npm install

# 开发（5173，热更新；dev 代理由 Vite 插件提供）
powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1

# 生产（3005，静态 dist + /api/media-proxy + /api/new-api）
powershell -ExecutionPolicy Bypass -File scripts\start-prod.ps1
```

停止与状态：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
powershell -ExecutionPolicy Bypass -File scripts\status.ps1
```

可选 demo 资产（各约 102 MB，默认不纳入仓库）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-demo-assets.ps1
```

## 环境变量

复制 `.env.example` 为 `.env`，至少填写：

```dotenv
ANTSK_API_KEY=your_api_key_here
VITE_MEDIA_PROXY_ENDPOINT=/api/media-proxy
VITE_MEDIA_PROXY_ENABLED=true
VITE_NEW_API_ENDPOINT=https://api.antsk.cn
```

## 目录

```text
components/     工作台与 InfiniteCanvas
services/       IndexedDB / OPFS / 模型与代理调用
server/         media proxy、new-api proxy core、生产静态服务器
scripts/        启停、状态、demo 资产恢复
docs/           产品与规格文档（规划）
types.ts        领域模型与画布状态
```

## 当前状态

- [x] C0 底座：归档源码导入、许可证/NOTICE/BASELINE、首个 git 提交
- [ ] C1 原生启动：脚本与生产静态服务器
- [ ] C2 数据权威：IndexedDB v3 → v4（画布图、版本、commit 记录）
- [ ] C4 画布引擎：持久化节点图 + 生成任务
- [ ] C5 双向互通：projection / commit / 版本与冲突

规格（SDD）暂存于 `E:\all-agent-workspace\infinite-studio\specs\006-bigbanana-fork-studio`。

## 原生画布 MCP（本地，无云端依赖）

- `server/canvasAgentBridge.mjs`：挂在 3005 生产服务上的同源 SSE 桥接，页面直连真实 IndexedDB/OPFS。
- `server/canvasMcp.mjs`：MCP stdio 服务，11 个工具（项目/画布/节点/资产导入/HTTP API）。
- `services/canvasAgentBridge.ts`：浏览器侧命令处理器。
- 文档：`docs/canvas-agent-mcp.md`、`docs/local-mcp-stack.md`。
