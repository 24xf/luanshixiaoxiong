# 《乱世枭雄》部署与调参指南

本文件汇总后端**所有可调环境变量**、**内置硬约束**、**启动命令示例**与**压测/容量参考**，方便上线时对着调。
所有变量均为**可选**，不设时走默认值（默认值已按"单实例稳定 + 长局安全"调好）。

> 约定：下文「纯内存策略」指仅影响服务端内存占用 / 录制保真度 / 持久化行为，**不改动任何游戏规则与英雄技能效果**（用户硬约束）。

---

## 1. 运行模式

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| 单实例 | 不设置 `REDIS_URL` | 缓存降级内存、总线降级 `LocalBus`；房间全部在本进程。 |
| 多实例（横向扩展） | 设置 `REDIS_URL` | 缓存走 Redis、总线走 `RedisBus`、跨实例用 `@socket.io/redis-adapter` 扇出；房间按归属分片到实例。 |

启动日志会打印 `distributed: true/false`、`replayMode` 等，可一眼确认当前模式。

---

## 2. 环境变量总表

### 2.1 服务端核心（server/index.ts）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | HTTP / Socket.IO 监听端口。改了它，**必须同步改 `vite.config.ts` 的代理 target**（默认 `http://localhost:3001`），否则前端连不上。 |
| `MAX_ROOMS` | `1000` | 单实例允许的最大房间数硬上限。超了 `createRoom` 会被拒。多实例下每个实例各自计这个上限。 |
| `MAX_SUBMITS_PER_SEC` | `50` | 单客户端（按 socket）每秒出拳/行动次数上限。超限**拒绝该次请求**（返回 false），**不踢人不断连**（O5 限流改为拒绝而非断连）。防单人刷接口。 |
| `OWNER_TTL_MS` | `30000` | 房间归属（owner）TTL。实例每 `OWNER_TTL/2` 心跳刷新一次；归属过期后别的实例可接管（脑裂防护）。多实例务必保留默认或调大，避免频繁抢归属。 |
| `METRICS_INTERVAL_MS` | `5000` | `/metrics` 与内部延迟采样（p50/p95/p99）的统计窗口。仅影响观测粒度，不影响游戏。 |

### 2.2 内存与录制（server/room.ts）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `REPLAY_MODE` | `all` | 回放录制保真度。可选值：`all`=每回合存完整棋盘快照（驱动 Phase4 可视化回放，最占内存）；`final`=只存回合事件流不存快照（回放降级为纯文字）；`off`=不存回放（最省内存，冲房间数时推荐）。**纯内存策略，不改规则。** |
| `REPLAY_MAX_SNAPS` | `300` | **仅 `REPLAY_MODE=all` 时生效**。回放缓冲区 `replayLog` 只保留最近 N 回合的棋盘快照，更旧回合 `delete` 掉 `snap`（事件流字段 `turn/throws/log` 仍在 → 前端自动降级纯文字）。防千年真人长局把几千回合棋盘全堆内存。**纯内存策略。** |
| `IDLE_ROOM_TTL` | `600000`（10 分钟） | 运行中房间**全员离线**后启动的空转兜底计时器（下限 5000ms，便于测试）。到期无重连则 `destroy()` 并清 Redis 持久化键，避免僵尸房 + 垃圾键堆积。有人重连即 `cancelDestroy()` 取消。沙盒房（无托管计时器）也被这层兜住。**纯内存策略。** |
| `TURN_GAP` | `400` | 回合之间的小间隔（ms），仅给客户端渲染留时间。**压测时可调大**（如 `1500`）降低机器人事件频率，不改任何规则/技能效果。 |

### 2.3 持久化与缓存

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 未设置 | 持久层数据源。**未设置 → 持久化禁用（游客模式，无战绩/回放入库）**。<br>SQLite 示例：`sqlite:./data/luanshi.db`（需 `NODE_OPTIONS=--experimental-sqlite`，见 §4）。<br>PostgreSQL 示例：`postgres://user:pass@host:5432/db`。 |
| `REDIS_URL` | 未设置 | 见 §1。设置即开启多实例横向扩展（缓存 + 总线 + redis-adapter 扇出）。务必指向同一 Redis。 |

### 2.4 调试

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEBUG` | 未设置 | 设置后开启 verbose：结构化日志额外 emit `debug` 事件，且 room 每回合打印 `T/W/A/R/alive/sumHp` 一行到控制台。排障用，生产别开（刷屏 + 轻微开销）。 |

### 2.5 Node 运行时标志

| 标志 | 何时需要 | 说明 |
| --- | --- | --- |
| `NODE_OPTIONS=--experimental-sqlite` | 用 SQLite 后端时 | `node:sqlite` 仍实验特性，必须带此 flag；PostgreSQL 后端不需要。 |

---

## 3. 内置硬约束（非 env，按设计不可改）

这些是游戏规则 / 架构约束，不暴露为环境变量，调参时别踩坑：

- **房间人数白名单 `ALLOWED_ROOM_SIZES = [2,3,4,5,6,7,8,9,10,12]`** —— **11 人明确禁止**（当年设计，非 bug）。压测随机人数必须对齐此白名单，否则 `startGame` 报「人数不支持」。
- **普通模式英雄唯一** → 普通房满员人数 = 当前英雄总数（现 12）。要开 12 人房需 ≥12 个英雄。
- **`playerCount` 上限 12**（沙盒同样 ≤12）。`setConfig({playerCount})` 仅在 `[2,12]` 内生效。
- **负载均衡必须按 roomId 粘滞**：`createRoom`/`joinRoom` 始终本地（不走跨实例路由），只有 `submitThrow`/`submitAction`/`reconnect` 走 `routeIntent` 转发。跨实例部署时 LB 必须按 roomId 粘滞，否则成员连错实例会建出空房间。

---

## 4. 启动命令示例

### 4.1 本地开发（前后端一条命令）

```bash
npm run dev
# 等价于：
#   SERVER: NODE_OPTIONS=--experimental-sqlite DATABASE_URL=sqlite:./data/luanshi.db tsx server/index.ts  (端口 3001)
#   VITE:   vite  (端口 5173，代理 /socket.io /api /health /metrics -> localhost:3001)
```
打开 `http://localhost:5173`。改 `vite.config.ts` 后**必须重启 vite**。

### 4.2 单实例生产（省内存冲房间数）

```bash
# SQLite 后端 + 关回放录制，单实例冲容量
NODE_OPTIONS=--experimental-sqlite \
DATABASE_URL=sqlite:./data/luanshi.db \
PORT=3001 MAX_ROOMS=5000 REPLAY_MODE=off \
npm run server
```

### 4.3 多实例分布式（Redis 总线 + 粘滞 LB）

```bash
# 第一步：起 Redis（本机可用 Memurai-for-Windows；生产用云 Redis）
redis-server --port 6379

# 第二步：每个实例各起一个进程，都连同一 Redis
PORT=3001 REDIS_URL=redis://localhost:6379 \
  DATABASE_URL=sqlite:./data/a.db NODE_OPTIONS=--experimental-sqlite npm run server
PORT=3002 REDIS_URL=redis://localhost:6379 \
  DATABASE_URL=sqlite:./data/b.db NODE_OPTIONS=--experimental-sqlite npm run server

# 第三步：前置 LB 按 roomId 粘滞，把流量导到 3001/3002
```
实测参考：双实例聚合 2689 房、三实例聚合峰值 3794 房，全程 0 error、p99 微秒级（详见 §6）。

---

## 5. 压测脚本参数

### 5.1 `server/capacity-test.ts`（房间数 / 长连接容量）

真实每房 N 条长连接建房开局，监控各实例 `/health`。关键 env：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVER_URLS` | `http://localhost:3001` | 逗号分隔多实例 URL。 |
| `ROOMS` | `90` | 总房间数。 |
| `PLAYERS` | `12` | 每房人数（真实长连接）。 |
| `PLAYERS_MIN` / `PLAYERS_MAX` | `0` | 设了则从合法白名单 `[2..10,12]` 随机人数（**11 禁**）。 |
| `HOLD_MS` | `120000` | 建房后保持时长。 |
| `BATCH` | `25` | 并发建房数（控制连接风暴）。 |
| `BATCH_GAP` | `400` | 批次间隔（ms），冲高时调大缓解握手排队。 |
| `CONNECT_TIMEOUT` | `20000` | socket 握手超时（冲高时握手排队需调大）。 |
| `SAMPLE_MS` | `5000` | `/health` 采样间隔。 |
| `WORKERS` | `1` | 多进程分摊客户端 CPU（≥1500 房务必 `WORKERS>=4`，否则压测客户端自己先饿死）。 |

⚠️ **本机自压自测警告**：≥2000 房或 ≥3 实例会把整机 CPU / 端口打爆（曾致 WorkBuddy 502、需重启）。压完立即清进程、等 ~4 分钟 `TIME_WAIT` 消退；真要 3000+ 房把压测客户端放**别的机器**。

### 5.2 `server/stress-test.ts`（功能/稳定压测，默认 6 人）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVER_URL` | `http://localhost:3001` | 目标实例。 |
| `BATCHES` | `3` | 批次数。 |
| `ROOMS_PER_BATCH` | `30` | 每批房间数。 |
| `PLAYERS` | `6` | 每房人数（需 `setConfig({playerCount})` 提升，默认房仅 10 人）。 |

---

## 6. 容量参考值（本机 dev 笔记本实测，2026-07-24）

> 瓶颈始终是**单进程 CPU / 事件循环**，内存与连接数远未到顶。

| 场景 | 结果 |
| --- | --- |
| 单实例 off 模式 | 1000 房×12 = 12000 长连接，0 失败、p99 0.011ms、堆峰值 527MB、压后完全回收；2000 房×12 = 13183 连接，0 失败、p99 0.014ms、堆峰值 497MB。 |
| 单实例 all 模式（存快照） | 400 房×12 峰值堆 216MB、单房 ~0.24MB、吞吐 ~6000 意图/秒、p99 0.013ms。 |
| 双实例聚合 | 2689 房（A=1642+B=1047），~13.9k sockets，聚合 tps≈6528，0 error，p99 0.022ms。 |
| 三实例聚合 | 峰值 3794 房 / ~13930 sockets / ~5822 意图/秒，三实例 error 全 0。 |
| 外推（压测客户端独立机器） | 单实例机器人满载 ~3000–5000 房、真人对局 ~1.5–3 万房（内存视角）；多实例线性乘法下「天花板是预算不是代码」。 |

---

## 7. 监控端点

| 端点 | 用途 |
| --- | --- |
| `GET /health` | 实例健康：rooms / sockets / heap / cpu / 意图延迟 / tps / `distributed`。压测与存活探测主用。 |
| `GET /metrics` | Prometheus 文本格式：延迟 p50/p95/p99、吞吐、房间数、内存、CPU。 |

所有日志为**结构化 JSON**（见 `server/log.ts`），便于接 Loki / ELK。
