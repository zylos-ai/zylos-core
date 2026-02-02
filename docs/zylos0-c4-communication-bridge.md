# C4 Communication Bridge - 详细设计

> 本文档是 [Zylos0 架构文档](https://zylos.jinglever.com/zylos0-architecture.md) 的补充
> 日期：2026-02-02
> 状态：设计确定，待实现

---

## 1. 概述

C4 Communication Bridge 是 Zylos0 Core 的核心组件，负责：
- **消息路由**：在 Claude 和外部 Channel 之间转发消息
- **消息记录**：所有进出消息持久化到 SQLite
- **会话延续**：通过 checkpoint 机制支持崩溃恢复
- **可审计性**：为企业场景提供完整对话日志

## 2. 设计原则

### 2.1 架构边界

```
┌─────────────────────────────────────────────────────────┐
│                      Core (可控)                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              C4 Communication Bridge             │   │
│  │  - 消息队列 (SQLite)                             │   │
│  │  - 对话日志                                      │   │
│  │  - Checkpoint 机制                               │   │
│  │  - tmux paste-buffer (隐藏实现)                  │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │ 标准接口
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Optional (不可控)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Telegram │  │   Lark   │  │  Discord │  ...         │
│  │  (官方)   │  │  (官方)   │  │  (社区)   │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
```

**关键原则**：
- C4 是唯一的消息网关
- 所有消息进出必须经过 C4
- 日志在 Core 层保证，不依赖外部组件
- 外部组件（包括社区贡献）只需遵循标准接口

### 2.2 vs OpenClaw

| 特性 | Zylos C4 | OpenClaw Gateway |
|------|----------|------------------|
| 复杂度 | SQLite + 脚本 | WebSocket 控制平面 |
| 安全性 | 本地化，无暴露端口 | 端口暴露，Shodan 可发现 |
| 可审计 | 结构化日志，完整记录 | 无统一日志 |
| 调试 | 简单，文件可查 | 复杂，难追踪 |
| 企业友好 | ✓ 合规支持 | ✗ |

## 3. 数据库设计

使用 SQLite，与 scheduler-v2 共用技术栈。

### 3.1 conversations 表

```sql
CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL,        -- 'in' | 'out'
    source TEXT NOT NULL,           -- 'telegram' | 'lark' | 'scheduler' | 'web'
    endpoint_id TEXT,               -- chat_id，可为 NULL (如 scheduler)
    content TEXT NOT NULL,          -- 消息内容
    checkpoint_id INTEGER,          -- 关联的 checkpoint
    FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id)
);

CREATE INDEX idx_conversations_timestamp ON conversations(timestamp);
CREATE INDEX idx_conversations_checkpoint ON conversations(checkpoint_id);
```

字段说明：
- `direction`: 'in' = 进入 Claude, 'out' = Claude 回复
- `source`: 消息来源/目标的 channel 类型
- `endpoint_id`: 具体的 chat_id（来源地或目的地）
- `checkpoint_id`: 该消息属于哪个 checkpoint 周期

### 3.2 checkpoints 表

```sql
CREATE TABLE checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL              -- 'memory_sync' | 'session_start' | 'manual'
);

CREATE INDEX idx_checkpoints_timestamp ON checkpoints(timestamp);
```

### 3.3 使用示例

```sql
-- 记录进入的消息
INSERT INTO conversations (direction, source, endpoint_id, content, checkpoint_id)
VALUES ('in', 'telegram', '8101553026', '[TG DM] howardzhou said: hello', 5);

-- 记录发出的消息
INSERT INTO conversations (direction, source, endpoint_id, content, checkpoint_id)
VALUES ('out', 'telegram', '8101553026', 'Hello Howard!', 5);

-- 创建 memory sync checkpoint
INSERT INTO checkpoints (type) VALUES ('memory_sync');

-- 查询最后一个 checkpoint 之后的所有对话
SELECT c.* FROM conversations c
WHERE c.timestamp > (
    SELECT timestamp FROM checkpoints ORDER BY timestamp DESC LIMIT 1
)
ORDER BY c.timestamp;
```

## 4. 接口设计

### 4.1 c4-receive（外部 → Claude）

外部组件调用此接口向 Claude 投递消息。

**CLI 接口**：
```bash
~/zylos/core/c4-receive.sh \
    --source telegram \
    --endpoint 8101553026 \
    --content '[TG DM] howardzhou said: hello'
```

**处理流程**：
1. 解析参数
2. 记录到 conversations 表 (direction='in')
3. 组装完整消息（追加 reply via）
4. 通过 tmux paste-buffer 发送给 Claude

**消息组装**：
```
输入 content: '[TG DM] howardzhou said: hello'
输出给 Claude: '[TG DM] howardzhou said: hello ---- reply via: ~/zylos/core/c4-send.sh telegram 8101553026'
```

**职责分离**：
- 外部组件：组装消息内容（如 `[TG DM] howardzhou said: ...`）
- C4：追加 `reply via` 路由信息

### 4.2 c4-send（Claude → 外部）

Claude 调用此接口发送回复。

**CLI 接口**：
```bash
~/zylos/core/c4-send.sh telegram 8101553026 "Hello Howard!"
```

**处理流程**：
1. 解析参数 (source, endpoint_id, content)
2. 记录到 conversations 表 (direction='out')
3. 查找对应 channel 的发送脚本
4. 调用 `~/zylos/channels/<source>/send.sh <endpoint_id> <content>`

### 4.3 c4-checkpoint（创建检查点）

由 memory-sync 任务调用，标记同步点。

**CLI 接口**：
```bash
~/zylos/core/c4-checkpoint.sh --type memory_sync
```

### 4.4 c4-recover（会话恢复）

崩溃恢复时调用，获取未同步的对话。

**CLI 接口**：
```bash
~/zylos/core/c4-recover.sh
```

**输出**：最后一个 checkpoint 之后的所有对话，格式化后可注入 Claude 上下文。

## 5. Channel 目录约定

外部组件遵循固定的目录结构：

```
~/zylos/channels/
├── telegram/
│   └── send.sh <endpoint_id> <message>
├── lark/
│   └── send.sh <endpoint_id> <message>
├── discord/
│   └── send.sh <endpoint_id> <message>
└── <community-channel>/
    └── send.sh <endpoint_id> <message>
```

**send.sh 规范**：
- 参数1：endpoint_id（如 chat_id）
- 参数2：消息内容
- 返回值：0 成功，非0 失败
- 标准输出：可选的状态信息

**示例 telegram/send.sh**：
```bash
#!/bin/bash
ENDPOINT_ID="$1"
MESSAGE="$2"
# 调用 Telegram API 发送消息
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$ENDPOINT_ID" \
    -d text="$MESSAGE"
```

## 6. 完整消息流程

### 6.1 接收消息

```
┌──────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────┐
│ Telegram Bot │ ──▶ │ c4-receive  │ ──▶ │   SQLite    │ ──▶ │ Claude  │
│              │     │ (追加reply  │     │ (记录 in)   │     │ (tmux)  │
│ 组装消息内容  │     │  via路径)   │     │             │     │         │
└──────────────┘     └─────────────┘     └─────────────┘     └─────────┘
```

### 6.2 发送回复

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ Claude  │ ──▶ │  c4-send    │ ──▶ │   SQLite    │ ──▶ │ channels/    │
│         │     │             │     │ (记录 out)  │     │ telegram/    │
│         │     │             │     │             │     │ send.sh      │
└─────────┘     └─────────────┘     └─────────────┘     └──────────────┘
```

### 6.3 会话恢复

```
┌───────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────┐
│ Activity      │ ──▶ │ c4-recover  │ ──▶ │   SQLite    │ ──▶ │ Claude  │
│ Monitor       │     │             │     │ (查询未同步 │     │ (注入   │
│ (检测恢复)    │     │             │     │  的对话)    │     │ 上下文) │
└───────────────┘     └─────────────┘     └─────────────┘     └─────────┘
```

## 7. 会话延续机制

### 7.1 Checkpoint 时机

- **memory_sync**：定时任务（如每30分钟）创建
- **session_start**：新会话开始时创建
- **manual**：手动创建（如重要操作前）

### 7.2 恢复流程

1. Activity Monitor 检测到 Claude 崩溃并恢复
2. 调用 `c4-recover.sh` 获取未同步对话
3. 格式化对话记录：
   ```
   [Session Recovery] 以下是崩溃前未同步的对话：

   [2026-02-02 14:30:15] IN (telegram:8101553026):
   [TG DM] howardzhou said: 我们继续讨论C4

   [2026-02-02 14:30:45] OUT (telegram:8101553026):
   好的，C4的设计要点是...

   请继续之前的对话。
   ```
4. 注入 Claude 上下文

## 8. 实现计划

### 8.1 文件结构

```
~/zylos/core/
├── c4-receive.sh      # 接收消息接口
├── c4-send.sh         # 发送消息接口
├── c4-checkpoint.sh   # 创建检查点
├── c4-recover.sh      # 会话恢复
├── c4-db.js           # 数据库操作 (Node.js)
└── c4.db              # SQLite 数据库

~/zylos/channels/
├── telegram/
│   └── send.sh
└── lark/
    └── send.sh
```

### 8.2 迁移步骤

1. 创建 C4 核心脚本
2. 创建 SQLite 数据库和表
3. 迁移现有 telegram-bot 使用 c4-receive
4. 迁移现有 lark-agent 使用 c4-receive
5. 更新 CLAUDE.md 中的 reply via 说明
6. 集成到 activity-monitor 恢复流程
7. 添加 c4-checkpoint 到 memory-sync 任务

## 9. 企业场景优势

### 9.1 合规审计

- 所有对话有完整记录
- 时间戳精确
- 来源/目的地可追溯
- 支持导出审计报告

### 9.2 故障排查

- 结构化日志，易于查询
- checkpoint 清晰标记边界
- 可重放历史对话

### 9.3 数据安全

- 本地化存储，不暴露端口
- SQLite 文件易于备份
- 无外部依赖

---

*文档作者：Zylos*
*日期：2026-02-02*
