# BigBanana 原生画布 MCP（Canvas Agent Bridge）

> 状态：v0.1，已在本机 3005 生产服务上完成端到端验证（2026-10-27）。
> 目标：完全本地、零云端依赖，让 AI 工具直接读写「真实页面 + 真实 IndexedDB」，把资料导入导演台/画布并能继续修改。

## 1. 为什么不是直接搬 upstream `canvas-agent`

已核对的事实：

| 项目 | 来源 | 许可证 | 画布实现 | 数据 |
|---|---|---|---|---|
| `infinite-canvas/canvas-agent` | `github.com/basketikun/infinite-canvas`（git remote 已核实） | MIT | React 19 + Ant Design + zustand，通用图片画布 | 自有 web 应用 + 本地 Agent 17371 端口 |
| BigBanana | `BigBanana AI Director` 归档快照 `09ea5ef0` | CC BY-NC-SA 4.0 | React 自绘 `InfiniteCanvas`（`CanvasNodeCard` + `CanvasEdgeLayer`），分镜/关键帧领域画布 | `BigBananaDB` v4 + OPFS |

两者没有共享代码或数据模型（互搜关键标识均为 0 命中），因此 **移植的是架构形态，不是源码**：
本地 Agent + 页面接入 + 原生工具面 + Bearer Token；数据模型对齐 BigBanana 的 `CanvasGraphEntity`。

## 2. 架构

```
DSH (MCP 客户端)
   │ stdio JSON-RPC
   ▼
server/canvasMcp.mjs            ← 工具面，9 个 bb_* 工具
   │ HTTP + Bearer Token (.run/canvas-agent.json)
   ▼
server/canvasAgentBridge.mjs    ← 挂载在 3005 生产服务
   │ 同源 SSE (/api/agent/stream) ↔ fetch (/api/agent/result)
   ▼
浏览器页面 services/canvasAgentBridge.ts
   │ 直接调用 storageService / projectionService
   ▼
真实 IndexedDB（BigBananaDB v4）+ OPFS
```

关键点：页面和桥接同源（都是 `http://127.0.0.1:3005`），不需要 CORS，也不新开浏览器；
所以用户原有项目数据（按 Origin 绑定）原地可见。

## 3. 启动 / 停止

```powershell
cd E:\all-agent-workspace\BigBanana
pwsh -File scripts/start-prod.ps1          # 构建（缺 dist 时）+ 启动，固定 3005
pwsh -File scripts/stop.ps1                # 按 .run/prod.pid 停止
```

浏览器打开 <http://127.0.0.1:3005> 后，页面会自动接入桥接；`/api/agent/status` 的
`pageConnected` 会变为 `true`。

## 4. MCP 注册

已注册为 DSH 连接 `bigbanana-canvas`（stdio，始终注入）：

```json
{
  "mcpServers": {
    "bigbanana-canvas": {
      "transport": "stdio",
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["E:/all-agent-workspace/BigBanana/server/canvasMcp.mjs"],
      "cwd": "E:/all-agent-workspace/BigBanana"
    }
  }
}
```

## 5. 工具清单

| 工具 | 作用 |
|---|---|
| `bb_agent_status` | 桥接/页面在线状态 |
| `bb_list_projects` | 列出全部项目/分集及画布存在性 |
| `bb_get_project` | 项目摘要 + 分镜/关键帧清单 |
| `bb_get_canvas` | 读取 v4 画布图（长字段自动截断） |
| `bb_project_to_canvas` | 导演台 → 画布 1:1 投影（幂等，保留排版） |
| `bb_upsert_node` | 新建/更新节点，支持 `expectedUpdatedAt` 乐观锁 |
| `bb_remove_node` | 删除节点并清理关联边 |
| `bb_import_asset` | URL/dataUrl → 资产库，可同时落 `reference_slot` 节点 |
| `bb_list_assets` | 资产库清单 |

## 6. 安全与数据边界

- 桥接只监听 `127.0.0.1:3005`，SSE 只接受同源（显式跨源会 403）。
- `/api/agent/rpc` 需要 Bearer Token；Token 每次启动重新生成，写在 `.run/canvas-agent.json`（已 gitignore）。
- 页面回传结果用每次连接独立的 nonce 校验，丢弃未知/过期命令。
- 写操作只落在画布图（`CANVAS_GRAPH_STORE`）与资产库，不改剧本/分镜主干字段。
- `expectedUpdatedAt` 不一致时拒绝写入，避免覆盖创作者正在编辑的画布。

## 7. 验证记录（2026-10-27）

- `npm run build` 通过（注意：esbuild 需 `TEMP=.tmp`，见 `start-prod.ps1`）。
- 无头 Chrome 打开 3005 → 3 秒内 `pageConnected=true`。
- MCP stdio：`initialize` → `tools/list`（9 个）→ `bb_agent_status`（在线）→ `bb_list_projects`（空库 `[]`，符合临时 profile）→ `bb_upsert_node` → `bb_get_canvas`（读回节点）→ `bb_remove_node` 全部成功。

## 8. 后续

- `bb_commit_artifact`：把画布产物写回导演台槽位（复用 `features/interop/commitService.ts` 的版本栈与 Stale 阻断）。
- 真实浏览器数据核验：在用户自己的浏览器刷新 3005 后，用 `bb_list_projects` 读真实项目。
