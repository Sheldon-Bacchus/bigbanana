# 本地原生 MCP 工具栈（BigBanana + infinite-canvas + Scrapling + Playwright）

> 目标：全部本机进程，零云端依赖；工具直接操作「真实页面 + 真实 IndexedDB」。
> 验证时间：2026-10-27。

## 0. 组件总览

| 能力 | 形态 | 端口/入口 | 依赖 |
|---|---|---|---|
| BigBanana 画布/项目数据 | 自建 MCP `bigbanana-canvas`（stdio） | 3005 内置桥接 `/api/agent/*` | 无第三方包 |
| infinite-canvas 画布 | 上游 `canvas-agent` MCP（stdio） | Agent HTTP `127.0.0.1:17372` + 网页 `43871` | canvas-agent 源码 |
| 网页抓取/浏览器采集 | `scrapling` MCP（stdio） | 本地 exe `C:\\Users\\ldc\\.local\\bin\\scrapling-mcp.exe` | Scrapling |
| 浏览器自动化/验证 | `@playwright/mcp`（stdio） | 本机 `E:\\all-agent-workspace\\tools\\playwright-mcp` | 系统 Chrome/Edge |
| BigBanana HTTP API | 扩展现有 MCP（计划/进行中） | `/healthz`、`/api/new-api/*` | 3005 |

## 1. BigBanana 画布 MCP

- 服务：`server/canvasMcp.mjs`；桥接：`server/canvasAgentBridge.mjs`（挂在 3005）。
- 9 个工具：`bb_agent_status / bb_list_projects / bb_get_project / bb_get_canvas / bb_project_to_canvas / bb_upsert_node / bb_remove_node / bb_import_asset / bb_list_assets`。
- 前提：本机浏览器打开 <http://127.0.0.1:3005>（刷新一次即可），页面自动接入桥接。

**已验证**（通过 DSH 内 MCP 工具调用，非脚本直连）：
```
bb_import_asset(projectId=ep_dsh_import, kind=scene, createNode=true)
→ assetId=asset-e23c..., nodeId=cnode-0391...
bb_get_canvas → nodes[0].data.imageUrl 以 data:image/png;base64, 开头
bb_remove_node → removed=true, nodeCount=0
```

## 2. infinite-canvas MCP（上游，已接入）

- MCP：`node node_modules/tsx/dist/cli.mjs src/index.ts mcp`（cwd=`infinite-canvas/canvas-agent`）。
- Agent HTTP：`http://127.0.0.1:17372`，token 在 `C:\\Users\\ldc\\.infinite-canvas\\canvas-agent.json`。
- 网页：`http://127.0.0.1:43871`（vite dev，当前在跑）。

**连接与绑定（已实测通过）**：
1. 打开 `http://127.0.0.1:43871/canvas?mode=new&agentUrl=http://127.0.0.1:17372&agentToken=<token>`
   - `mode=new` 会在空库时自动新建并进入一张画布（`pages/canvas/index.tsx:66-69`）；
   - `agentUrl/agentToken` 自动连接本地 Agent（`components/agent/local-agent-panel.tsx:195`）。
2. 调 `canvas_connection_status` —— 它同时注册本 MCP 会话；
3. 取 `clients[].clientId`（必须已有 `projectId`，见 `canvas/session.ts:98`），调 `canvas_bind_connection({clientId, takeover:true})`；
4. 之后 `canvas_list_projects` / `canvas_get_state` / `canvas_apply_ops` 等 40+ 工具可用。

**实测回执**（走 DSH 内 MCP 工具）：
```
canvas_connection_status → clients:[{clientId:"0jLyy5RiOWFy0Gpt2UfEF", projectId:"JVRib_xvowkQ_E3DNN00R", title:"无限画布 1"}]
canvas_bind_connection    → {"ok":true,"binding":{...}}
canvas_list_projects      → total=1, items[0].title="无限画布 1"
canvas_get_state          → hasCanvas=true, nodes=[], viewport={x:0,y:0,k:1}
```

> 注意：每个新 MCP 会话都要先 `canvas_connection_status` 注册、再 `canvas_bind_connection` 绑定；`takeover:true` 会顶掉同一网页上的旧会话。
>
> 配置目录：`canvas-agent` 默认读 `os.homedir()/.infinite-canvas`（`src/config.ts:7`）。若运行环境的 homedir 不是 `C:\\Users\\ldc`，启动 MCP 时必须注入 `CANVAS_AGENT_CONFIG_DIR=C:\\Users\\ldc\\.infinite-canvas`，否则会读到 17371 端的旧配置。

## 3. Scrapling（本地，非云端）

- `scrapling-mcp.exe` 为本地 stdio 进程，16 个工具：`make_request / browser_fetch_once / browser_open / browser_extract / browser_actions / browser_evaluate / browser_network_requests / browser_screenshot / …`。
- **实测**：
  - `make_request https://example.com` → HTTP 200；
  - `browser_fetch_once http://127.0.0.1:3005/` → 抓回 BigBanana 首页 Markdown（说明能抓本地部署页）。
- 无云端端点、无 API Key 依赖。

## 4. Playwright MCP（本地，非云端）

- 安装位置：`E:\\all-agent-workspace\\tools\\playwright-mcp\\node_modules\\@playwright\\mcp\\cli.js`，25 个工具。
- 本机已安装 `ms-playwright/chromium-1248`；该 MCP 自带 playwright 版本期望 `chromium-1247`，因此推荐直接用系统 Chrome：
  ```
  node <cli.js> --headless --isolated --executable-path "C:/Program Files/Google/Chrome/Application/chrome.exe"
  ```
- **实测**：`browser_navigate http://127.0.0.1:3005/` → Page Title = “BigBanana AI Director …”，`browser_evaluate document.title` 返回一致。
- 现有 DSH 连接 `asset-browser` 使用扩展模式（`--extension --executable-path msedge`），需要浏览器扩展与 token 才能接管你已登录的窗口。

## 5. BigBanana HTTP API → MCP（已实现）

- BigBanana 没有独立业务 REST API；HTTP 面只有 `/healthz`、`/api/new-api/*`（new-api 反向代理）、`/api/media-proxy`。
- 已在 `server/canvasMcp.mjs` 增加：
  - `bb_api_status`：合并返回 `/healthz` 与 `/api/new-api/status`；
  - `bb_api_request({method,path,body,timeoutMs})`：仅允许 `/healthz` 与 `/api/new-api/` 前缀，其他路径直接拒绝。
- **实测**：
  ```
  bb_api_status → status=200, service=bigbanana-prod, uptimeMs=967258
  bb_api_request GET /api/new-api/status?endpoint=https://api.antsk.cn
      → 返回上游真实数据（HeaderNavModules / SidebarModulesAdmin / announcements…）
  bb_api_request GET /etc/passwd
      → 错误：拒绝访问路径：/etc/passwd。仅允许访问 /healthz 与 /api/new-api/ 前缀
  ```
- 说明：`/api/new-api` 是反向代理，业务数据仍在浏览器 IndexedDB（由画布工具覆盖）；生成/账号类调用走这个口。

## 6. 启停

```powershell
cd E:\all-agent-workspace\BigBanana
pwsh -File scripts/start-prod.ps1 -SkipBuild   # 3005
pwsh -File scripts/stop.ps1

# infinite-canvas（已在跑时的现状）
# 网页 vite: 127.0.0.1:43871；Agent: 127.0.0.1:17372
```
