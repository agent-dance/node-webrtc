# 斗地主多人游戏设计文档

> 基于 ts-rtc DataChannel，支持人类与 Agent 混合对局

---

## 一、核心原则

**协议对称，接口分层。**

Agent 和人类走完全相同的 WebRTC DataChannel 协议通路，差异只在"最后一公里"：

- 人类客户端 → 渲染成牌面 / 动画 / 按钮
- Agent 进程 → 直接以结构化数据作为决策输入

服务器不区分对端是人还是 Agent。

---

## 二、整体架构

```
Flutter (人类)  ── DataChannel ──┐
                                  ├──► Node.js 权威游戏服务器
Agent 进程      ── DataChannel ──┘         │
                                           ├── GameEngine      (纯函数，零 IO)
                                           ├── PlayerAdapter   (统一接口)
                                           └── AgentRuntime    (可插拔)
```

### 拓扑说明

- 所有玩家（无论人还是 Agent）都只连服务器，服务器是唯一权威裁判
- Agent 是**独立进程**，不是服务器内置逻辑，通过相同 WebRTC 协议接入
- 信令服务器复用现有 `apps/signaling-server`，房间上限改为 3 人

---

## 三、目录结构

```
apps/
└── doudizhu/
    ├── server/                  # Node.js 权威游戏服务器
    │   ├── src/
    │   │   ├── index.ts
    │   │   ├── engine/
    │   │   │   ├── card.ts          # 牌的定义与比较
    │   │   │   ├── pattern.ts       # 牌型识别
    │   │   │   ├── validator.ts     # 出牌合法性校验
    │   │   │   ├── evaluator.ts     # 手牌强度评分
    │   │   │   └── state-machine.ts # 游戏状态机
    │   │   ├── room/
    │   │   │   ├── room.ts          # 房间（3个座位）
    │   │   │   └── manager.ts       # 房间管理
    │   │   ├── player/
    │   │   │   ├── adapter.ts       # PlayerAdapter 接口
    │   │   │   ├── human-adapter.ts # 挂起等 DataChannel 消息
    │   │   │   └── agent-adapter.ts # 直接调用 Brain.decide()
    │   │   └── agent/
    │   │       ├── brain.ts         # Agent Brain 接口
    │   │       ├── rule-brain.ts    # L1 规则 Agent
    │   │       ├── mcts-brain.ts    # L3 蒙特卡洛 Agent
    │   │       └── remote-brain.ts  # 转发给外部 HTTP API
    │   ├── package.json
    │   └── tsconfig.json
    │
    ├── flutter-client/          # Flutter 人类客户端
    │   └── lib/
    │       ├── main.dart
    │       ├── services/
    │       │   ├── signaling_service.dart
    │       │   └── webrtc_service.dart
    │       └── screens/
    │           ├── lobby_screen.dart
    │           └── game_screen.dart
    │
    └── agent-client/            # 独立 Agent 进程（Node.js）
        ├── src/
        │   ├── index.ts         # 连接信令，加入房间
        │   └── brains/          # 与 server/agent/ 共享接口
        └── package.json
```

---

## 四、GameView：同一份数据，两种呈现

服务器只维护并发送一种数据结构。Flutter 渲染成 UI，Agent 直接用于决策。

```typescript
interface GameView {
  // ── 基础信息（人和 Agent 都需要）──────────────────────────────
  phase: 'waiting' | 'bidding' | 'playing' | 'over'
  myHand: Card[]
  myRole: 'landlord' | 'farmer' | null
  bottomCards: Card[] | null       // 叫牌结束后才出现
  currentTurn: string
  isMyTurn: boolean
  timeoutMs: number                // 距离超时的剩余毫秒

  // ── 公开信息 ───────────────────────────────────────────────────
  players: {
    id: string
    type: 'human' | 'agent'        // 对手知道谁是 Agent
    cardCount: number
    bid: number | null             // 叫分结果公开
  }[]
  lastPlay: PlayRecord | null      // 上一手出牌（需要压过它）
  history: PlayRecord[]            // 完整出牌历史

  // ── Agent 友好字段（人类客户端忽略）──────────────────────────
  legalMoves: Card[][]             // 服务器预计算所有合法出法
  handStrength: number             // 手牌强度 0–100
  landlordProbability: number[]    // [我, 左邻, 右邻] 各自是地主的概率
}
```

> **`legalMoves` 是关键设计**：服务器替 Agent 算好全部合法出法，Agent 只需从中选一个，
> 无需自己实现牌型验证，任何语言编写的 Agent 都能轻松接入。

---

## 五、统一 PlayerAdapter 接口

游戏引擎代码里永远不出现 `if human / else if agent`，对所有玩家一视同仁。

```typescript
interface PlayerAdapter {
  id: string
  type: 'human' | 'local-agent' | 'remote-agent'

  // 服务器向玩家"提问"——挂起直到有响应或超时
  requestBid(view: GameView): Promise<BidAction>
  requestPlay(view: GameView): Promise<PlayAction>

  // 服务器向玩家"通知"——无需响应
  notify(event: GameEvent): void
}
```

| 实现 | requestPlay() 行为 |
|------|-------------------|
| `HumanAdapter` | 发送 `PLAY_REQUEST` 消息，挂起 Promise，等 DataChannel 收到回包后 resolve |
| `AgentAdapter` | 直接调用 `brain.decide(view)`，同步或异步返回 |

超时统一由 `PlayerAdapter` 基类处理：

```typescript
// 基类中
async requestPlay(view: GameView): Promise<PlayAction> {
  return Promise.race([
    this.doRequestPlay(view),
    sleep(view.timeoutMs).then(() => this.fallbackAction(view))
  ])
}
```

人类超时自动 pass，Agent 超时触发 L1 备用决策。

---

## 六、Agent 可插拔 Brain

```typescript
interface Brain {
  decide(view: GameView, legalMoves: Card[][]): Promise<Card[]>
  bid(view: GameView): Promise<number>  // 返回 0/1/2/3
}
```

### L1 RuleBrain（规则 Agent）

- 叫分：手牌有 2 张以上大牌（A/2/大小王）就叫 3，否则叫 1 或不叫
- 出牌：从合法出法里选剩余手牌张数最少的结果（贪心减张）
- 保留炸弹到最后

### L2 EvalBrain（评估 Agent）

- 对每个合法出法评估：`score = handStrength(remainingHand) - penalty(giveOpponentChance)`
- 选分最高的

### L3 MCTSBrain（蒙特卡洛树搜索）

- 对对手手牌分布进行蒙特卡洛采样（已知对手张数 + 已出牌历史可推断）
- 每步模拟 N 局，取胜率最高的出法
- 计算时间预算：`timeoutMs * 0.8`

### L4 RemoteBrain（接外部模型）

```typescript
// Agent 进程把 GameView 原样转发给外部 API（LLM / RL 模型均可）
const res = await fetch(this.endpoint + '/decide', {
  method: 'POST',
  body: JSON.stringify({ view, legalMoves }),
})
return res.json() as Card[]
```

任何能起 HTTP 服务的模型（Python RL、LLM Function Calling 等）都可以接入，无需改动游戏服务器代码。

---

## 七、消息协议

所有消息通过 `ordered: true` DataChannel `game` 收发。

### 客户端 → 服务器

| type | payload | 说明 |
|------|---------|------|
| `JOIN_ROOM` | `{ roomId, playerId, playerType: 'human'\|'agent' }` | 加入房间 |
| `BID` | `{ score: 0\|1\|2\|3 }` | 叫分（0=不叫） |
| `PLAY` | `{ cards: Card[] }` | 出牌（空数组=pass） |
| `READY` | `{}` | 准备开始 |

### 服务器 → 客户端

| type | payload | 说明 |
|------|---------|------|
| `ROOM_STATE` | `{ players: PlayerInfo[], config: RoomConfig }` | 房间状态更新 |
| `DEAL` | `{ view: GameView }` | 发牌，携带初始视图 |
| `BID_REQUEST` | `{ view: GameView }` | 轮到你叫分 |
| `BID_RESULT` | `{ winner: string, score: number, view: GameView }` | 叫分结果，地主公开底牌 |
| `PLAY_REQUEST` | `{ view: GameView }` | 轮到你出牌 |
| `PLAY_RESULT` | `{ playerId: string, cards: Card[], view: GameView }` | 某人出牌结果，广播给所有人 |
| `GAME_OVER` | `{ winner: 'landlord'\|'farmers', scores: Record<string, number> }` | 游戏结束 |
| `PLAYER_TIMEOUT` | `{ playerId: string, action: 'pass'\|'bid-0' }` | 超时自动操作通知 |

---

## 八、房间配置

```typescript
interface RoomConfig {
  id: string
  seats: SeatConfig[]   // 固定 3 个
  fallbackAgent: 'rule' | 'mcts'  // 人离线后接管
}

type SeatConfig =
  | { type: 'open' }                                        // 等人类加入
  | { type: 'agent'; level: 'rule' | 'mcts' }              // 本地 Agent
  | { type: 'agent'; level: 'remote'; endpoint: string }   // 远程 Agent
```

**典型配置：**

```typescript
// 1人 + 2本地Agent（单机练习）
{ seats: [{ type: 'open' }, { type: 'agent', level: 'rule' }, { type: 'agent', level: 'mcts' }] }

// 3人对战，离线自动托管
{ seats: [{ type: 'open' }, { type: 'open' }, { type: 'open' }], fallbackAgent: 'rule' }

// 人类 vs 外部RL模型
{ seats: [{ type: 'open' }, { type: 'agent', level: 'remote', endpoint: 'http://rl-agent:8000' }, { type: 'agent', level: 'rule' }] }
```

---

## 九、人类离线处理

```
Human DataChannel 断开
        │
        ▼
HumanAdapter 检测到 close 事件
        │
        ▼
自动升级为 FallbackAgentAdapter（L1 RuleBrain）
        │
        ├── 游戏继续，不中断
        │
        └── 重连后：FallbackAgent 降级，HumanAdapter 恢复
            （重连拿到最新 GameView，从当前状态继续）
```

---

## 十、信息边界保障

服务器在发送前强制裁剪状态，防止作弊：

```
完整 GameState（服务器内存）
        │
        ▼
buildView(state, playerId)   ← 按接收方身份裁剪
        │
        ├── myHand：只含该玩家自己的牌
        ├── others.cards：字段不存在（只有 cardCount）
        ├── bottomCards：叫牌结束前为 null
        └── legalMoves：服务器实时计算，不依赖客户端校验
```

即使 Agent 或恶意客户端发来非法出牌，服务器也会用 `validator.validate()` 二次校验并拒绝。

---

## 十一、DataChannel 配置

```typescript
// 游戏核心消息：可靠有序（出牌顺序绝对不能乱）
pc.createDataChannel('game', { ordered: true })

// 聊天 / 表情：允许丢失
pc.createDataChannel('chat', { ordered: false, maxRetransmits: 0 })
```

斗地主节奏慢（秒级回合），不需要不可靠传输，全部走可靠 channel。

---

## 十二、与现有 demo 的关系

| 组件 | 现有 demo | 斗地主复用策略 |
|------|---------|--------------|
| 信令服务器 | `apps/signaling-server` | 直接复用，房间上限改为 3 |
| DataChannel 模式 | Scenario 3 Snake 已验证 | 相同 ordered=true 模式 |
| 权威服务器范式 | Snake 服务器端 tick | 复用架构，替换引擎逻辑 |
| Flutter 信令客户端 | `signaling_service.dart` | 直接复用 |
| Agent 接入 | — | 新增，独立进程走相同协议 |

---

## 十三、实现优先级

```
Phase 1：可玩
  ✦ GameEngine 核心（牌型/规则/状态机）+ 单元测试
  ✦ HumanAdapter + 基础 Flutter UI
  ✦ L1 RuleBrain（填满空位，游戏可以跑起来）

Phase 2：好玩
  ✦ L3 MCTSBrain
  ✦ 超时 / 离线接管
  ✦ 积分 / 对局记录

Phase 3：可扩展
  ✦ RemoteBrain HTTP 接口
  ✦ 旁观者模式
  ✦ 房间配置 UI
```
