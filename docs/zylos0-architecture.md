# Zylos0 原型机技术架构

> Version: 1.0 Draft
> Date: 2026-02-01
> Status: Design Phase

## 1. 架构概述

Zylos0 是一个自主AI Agent的最小可行原型。设计原则是**最小生存单元** - 只保留维持自主运行所必需的组件，其他能力作为可插拔模块。

### 1.1 设计原则

1. **生存优先**: Core组件确保Agent能存活和自我恢复
2. **松耦合**: Optional组件可独立添加/移除，不影响Core
3. **单一职责**: 每个组件只做一件事
4. **接口标准化**: 组件间通过定义好的接口通信

---

## 2. 组件拆分

### 2.1 组件与Skill的关系

**关键区分**:
- **Skill目录** = SKILL.md + 代码 + 脚本 (可升级覆盖)
- **组件数据目录** = 配置 + 数据 (升级时保留)

**目录分离原则**:
```
~/.claude/skills/              # Skills目录 (代码+指令，可升级)
├── telegram-bot/
│   ├── SKILL.md               # 指令：如何使用Telegram组件
│   ├── bot.js                 # 后台服务代码
│   └── send-reply.sh          # 脚本
├── task-scheduler/
│   ├── SKILL.md               # 指令：如何使用调度器
│   ├── scheduler.js           # 调度服务
│   ├── task-cli.js            # CLI工具
│   └── activity.js            # 活动监控
└── ...

~/zylos/                       # 组件数据目录 (配置+数据，保留)
├── telegram-bot/
│   └── config.json            # token, chat_id等敏感配置
├── scheduler/
│   ├── config.json            # 调度器配置(如有)
│   └── scheduler.db           # 任务数据库
├── memory/                    # 记忆数据
│   ├── context.md
│   ├── decisions.md
│   └── ...
└── ...
```

**分离原则**:
- **Skills目录**: SKILL.md + 代码 + 脚本，可随版本升级覆盖
- **组件数据目录**: 配置 + 数据，按组件分目录，升级时保留
- 每个组件的配置和数据自包含在 `~/zylos/<component>/`

**为什么这样分**:
- 代码和指令一起升级，保持一致性
- 配置/数据/credentials不被覆盖
- 按组件分目录，结构清晰不散落

**SKILL.md内容** (遵循Anthropic规范):

```yaml
---
name: telegram-bot
description: Send messages via Telegram. Use when need to notify Howard or reply to Telegram messages.
upgrade:
  repo: zylos-ai/zylos-telegram
  version: 1.0.0
  check_frequency: weekly
---
```

```markdown
# Telegram Bot

## When to Use
- Replying to Telegram messages from Howard
- Sending notifications or alerts

## How to Use
~/.claude/skills/telegram-bot/send-reply.sh "message"

## Config Location
- Config file: ~/zylos/telegram-bot/config.json

## Service Management
- Check status: pm2 status telegram-bot
- View logs: pm2 logs telegram-bot
- Restart: pm2 restart telegram-bot
```

**渐进披露**:
1. Claude启动时只加载skill的description (~100 tokens)
2. 需要时加载完整SKILL.md内容
3. 按需读取引用的文档

### 2.2 Core Components (生存必需)

| ID | Component | Purpose | Skill职责 |
|----|-----------|---------|-----------|
| C1 | **Claude Runtime** | AI推理引擎 | tmux管理、启动/重启指令 |
| C2 | **Self-Maintenance** | 监控/崩溃恢复/升级 | 升级流程、健康检查指令 |
| C3 | **Memory System** | 跨session持久化记忆 | 记忆文件读写规范 |
| C4 | **Communication Bridge** | 通讯桥接层协议 | 消息格式说明 |
| C5 | **Task Scheduler** | 自主任务调度 | task-cli使用方法 |
| C6 | **HTTP Layer (Caddy)** | Web Console + File Sharing | 文档分享指令 |

**文件布局示例**:
```
# Skill (代码+指令，可升级)
~/.claude/skills/task-scheduler/
├── SKILL.md           # 使用说明
├── scheduler.js       # 调度服务
├── task-cli.js        # CLI工具
├── activity.js        # 活动监控
└── db.js              # 数据库操作

# 组件数据 (配置+数据，保留)
~/zylos/scheduler/
├── config.json        # 配置(如有)
└── scheduler.db       # 任务数据库
```

### 2.3 Optional Components (可插拔增强)

| ID | Component | Purpose | 依赖 |
|----|-----------|---------|------|
| O1 | Telegram Bot | 移动端通讯 | C4 |
| O2 | Lark Bot | 团队协作通讯 | C4 |
| O3 | Discord Bot | 社区通讯 | C4 |
| O4 | Browser Automation | Web操作能力 | C1 |
| O5 | Knowledge Base | 结构化知识存储 | C3 |

**文件布局示例**:
```
# Skill (代码+指令，可升级)
~/.claude/skills/telegram-bot/
├── SKILL.md           # 使用说明
├── bot.js             # Bot后台服务
└── send-reply.sh      # 发送消息脚本

# 组件数据 (配置，保留)
~/zylos/telegram-bot/
└── config.json        # token, chat_id等敏感配置
```

---

## 3. 依赖关系图

> 注：Core和Optional的区别仅在于「必装」vs「选装」，实现机制统一为Skills。

```
                    ┌─────────────────────────────────────────────────┐
                    │              OPTIONAL LAYER                      │
                    │  ┌─────────┐ ┌─────────┐ ┌─────────┐           │
                    │  │Telegram │ │  Lark   │ │ Discord │  ...      │
                    │  │   O1    │ │   O2    │ │   O3    │           │
                    │  └────┬────┘ └────┬────┘ └────┬────┘           │
                    │       │           │           │                 │
                    │       └───────────┼───────────┘                 │
                    │                   ▼                             │
                    │  ┌─────────┐ ┌─────────┐                       │
                    │  │ Browser │ │   KB    │                       │
                    │  │   O4    │ │   O5    │                       │
                    │  └────┬────┘ └────┬────┘                       │
                    └───────┼───────────┼─────────────────────────────┘
                            │           │
════════════════════════════╪═══════════╪═════════════════════════════════
                            │           │
                    ┌───────┼───────────┼───────────┼─────────────────┐
                    │       ▼           ▼           ▼   CORE LAYER    │
                    │  ┌─────────────────────────────────────────┐    │
                    │  │           C1: Claude Runtime             │    │
                    │  │      (tmux session + Claude Code)        │    │
                    │  └──────────────────┬──────────────────────┘    │
                    │                     │                           │
                    │         ┌───────────┼───────────┐               │
                    │         ▼           ▼           ▼               │
                    │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
                    │  │   C3:    │ │   C4:    │ │   C5:    │        │
                    │  │ Memory   │ │ CommChan │ │Scheduler │        │
                    │  └──────────┘ └─────┬────┘ └────┬─────┘        │
                    │                     │           │               │
                    │                     └─────┬─────┘               │
                    │                           ▼                     │
                    │                    ┌──────────┐                 │
                    │                    │   C2:    │                 │
                    │                    │ Activity │◄── Guardian     │
                    │                    │ Monitor  │    (外部监控)   │
                    │                    └──────────┘                 │
                    └─────────────────────────────────────────────────┘
```

### 3.1 依赖关系说明

```
C1 (Claude Runtime)
 ├── C2 (Self-Maintenance) - 监控C1状态，崩溃时重启
 ├── C3 (Memory System) - C1读写记忆文件
 ├── C4 (Communication) - C1通过此接收/发送消息
 └── C5 (Scheduler) - C1执行调度的任务

C4 (Communication Channel)
 ├── O1 (Telegram) - 实现C4接口
 ├── O2 (Lark) - 实现C4接口
 └── O3 (Discord) - 实现C4接口

C3 (Memory System)
 └── O5 (KB) - 扩展C3的存储能力

C1 (Claude Runtime)
 └── O4 (Browser) - C1调用Browser执行Web任务
```

---

## 4. 接口规范

### 4.1 C2: Self-Maintenance Interface

**职责**: 监控状态、崩溃恢复、主动重启、版本升级

**状态机**:
```
OFFLINE ──(start)──► STOPPED ──(claude启动)──► BUSY
                         ▲                        │
                         │                        ▼
                    (崩溃/退出)                  IDLE
                         │                        │
                         └────────────────────────┘
```

**输出接口** (`~/.claude-status`):
```json
{
  "status": "idle|busy|stopped|offline",
  "timestamp": 1706745600,
  "last_activity": 1706745590,
  "session_start": 1706740000
}
```

**核心功能**:

| 功能 | 触发方式 | 行为 |
|------|----------|------|
| 状态监控 | 持续运行 | 检测Claude活动状态 |
| 崩溃恢复 | 自动检测 | STOPPED → 等待 → 重启 |
| 主动重启 | 命令触发 | 发送/exit → 等待退出 → 重启 |
| 版本升级 | 命令触发 | 发送/exit → 运行升级脚本 → 重启 |

**脚本接口**:
```bash
restart-claude.sh    # 主动重启 (发送/exit, 由Guardian重启)
upgrade-claude.sh    # 升级流程 (发送/exit, curl升级, 由Guardian重启)
```

**Guardian原则**: 所有重启最终由Self-Maintenance执行，脚本只负责触发退出

### 4.2 C3: Memory System Interface

**职责**: 跨session持久化Agent的记忆和状态

**文件结构**:
```
~/zylos/memory/
├── context.md      # 当前工作上下文 (频繁更新)
├── decisions.md    # 关键决策记录
├── projects.md     # 项目状态追踪
└── preferences.md  # 用户偏好
```

**读取接口**: 直接读取markdown文件
**写入接口**: 直接写入markdown文件 (git commit由Git Snapshot任务统一处理)

**扩展点**:
- O5 (KB): 通过 `kb-cli` 命令行接口扩展

### 4.3 C4: Communication Bridge Interface

> **详细设计文档**: [C4 Communication Bridge 详细设计](https://zylos.jinglever.com/zylos0-c4-communication-bridge.md)

**职责**:
- 提供人机双向通信的统一网关
- 消息队列和持久化 (SQLite)
- 对话日志和审计
- 会话延续 (checkpoint机制)

**架构原则**:
- C4 是**唯一的消息网关**，所有进出必须经过 C4
- 日志在 Core 层保证，不依赖外部组件
- 外部组件（包括社区贡献）只需遵循标准接口

**核心设计原则**:
> Core只定义消息传递**机制**，不定义消息**格式**。
> 类似HTTP层 - 只管传输，不管内容。消息格式由各组件自定义。

**C4 接口**:

| 接口 | 方向 | 说明 |
|------|------|------|
| c4-receive | 外部→Claude | 外部组件调用，投递消息给Claude |
| c4-send | Claude→外部 | Claude调用，发送回复 |
| c4-checkpoint | 内部 | 创建会话检查点 (memory sync时调用) |
| c4-recover | 内部 | 崩溃恢复时获取未同步对话 |

**Channel 目录约定**:
```
~/zylos/channels/
├── telegram/
│   └── send.sh <endpoint_id> <message>
├── lark/
│   └── send.sh <endpoint_id> <message>
└── discord/
    └── send.sh <endpoint_id> <message>
```

**消息流程**:
```
接收: 外部组件 → c4-receive (组装reply via) → SQLite记录 → Claude
发送: Claude → c4-send → SQLite记录 → channels/<source>/send.sh → 外部
```

**消息格式** (组件自定义):
- 外部组件负责组装消息内容 (如 `[TG DM] howardzhou said: Hello`)
- C4 负责追加 `reply via` 路由信息
- 格式可独立演进，互不影响

**示例**:
```
# 外部组件调用 c4-receive
c4-receive --source telegram --endpoint 8101553026 --content '[TG DM] howardzhou said: Hello'

# C4 组装后发给 Claude
[TG DM] howardzhou said: Hello ---- reply via: ~/zylos/core/c4-send.sh telegram 8101553026
```

**企业场景优势**:
- 可审计: 所有对话有完整记录
- 可追溯: 来源/目的地/时间戳
- 会话延续: checkpoint机制支持崩溃恢复

### 4.4 C5: Task Scheduler Interface

**职责**: 管理和调度自主任务

**数据结构** (SQLite: `scheduler.db`):
```sql
-- 主任务表
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,              -- 任务名称
  description TEXT,                -- 任务描述
  prompt TEXT NOT NULL,            -- 发送给Claude的提示词

  -- 调度配置
  type TEXT NOT NULL,              -- 'one-time' | 'recurring' | 'interval'
  cron_expression TEXT,            -- cron表达式 (recurring类型)
  interval_seconds INTEGER,        -- 间隔秒数 (interval类型)
  timezone TEXT DEFAULT 'Asia/Shanghai',

  -- 时间追踪
  next_run_at INTEGER NOT NULL,    -- 下次执行时间
  last_run_at INTEGER,             -- 上次执行时间

  -- 优先级与状态
  priority INTEGER DEFAULT 3,      -- 1=紧急, 2=高, 3=普通, 4=低
  status TEXT DEFAULT 'pending',   -- pending/running/completed/failed/paused

  -- 重试逻辑
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,

  -- 元数据
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- 错误追踪
  last_error TEXT,
  failed_at INTEGER
);

-- 执行历史表
CREATE TABLE task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  executed_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,            -- started/success/failed/timeout
  duration_ms INTEGER,
  error TEXT
);
```

**CLI接口** (`task-cli`):
```bash
# 基础操作
task-cli list                                    # 列出任务
task-cli add "<prompt>" [options]                # 添加任务
task-cli update <task-id> [options]              # 修改任务
task-cli remove <task-id>                        # 删除任务
task-cli done <task-id>                          # 标记完成

# 状态管理
task-cli pause <task-id>                         # 暂停任务
task-cli resume <task-id>                        # 恢复任务
task-cli status                                  # Claude状态

# 查询
task-cli history [task-id]                       # 执行历史
task-cli next                                    # 即将执行
task-cli running                                 # 正在运行

# 添加/修改选项
--in "<duration>"       # 一次性: X时间后 (如 "30 minutes")
--at "<time>"           # 一次性: 指定时间 (如 "tomorrow 9am")
--cron "<expression>"   # 周期性: cron表达式 (如 "0 8 * * *")
--every "<interval>"    # 间隔性: 每隔X时间 (如 "4 hours")
--priority <1-4>        # 优先级
--name "<name>"         # 任务名称
--prompt "<text>"       # 任务提示词 (仅update)
```

**调度逻辑**:
1. 检查Claude进程存活 (tmux session存在)
2. 到点直接发送任务 (无需等idle，Claude自己排队处理)
3. 通过tmux paste-buffer发送任务prompt
4. 等待任务完成标记

**内置默认任务** (Core):

| 任务 | 频率 | 功能 | 执行者 |
|------|------|------|--------|
| Memory Sync | 每30分钟 | 更新记忆文件(context.md等)，保存当前工作状态 | C5 |
| Git Snapshot | 每4小时 | git commit工作目录和skills目录，本地版本控制 | C5 |
| Auto Upgrade | 每日 | 检查并升级Claude Code | C2 |
| Health Check | 每4小时 | 系统健康检查 | C5 |

这些任务默认启用，频率可配置。

**任务职责说明**:
- **Memory Sync**: 让Agent主动更新记忆文件，记录当前在做什么、重要决策等
- **Git Snapshot**: 本地版本控制，不推送远程，便于实验出错时回滚

**Git Snapshot覆盖范围**:
```bash
# 两个独立的git仓库，分别管理
~/zylos/              # 配置、数据 (升级时保留)
~/.claude/skills/     # SKILL.md + 代码 + 脚本 (可升级)
```

**为什么skills也需要git管理**:
- 日常会修改脚本和SKILL.md描述
- 升级前可以commit当前状态，便于diff对比
- 冲突时可以选择性合并
- 保护本地定制不丢失

### 4.4.1 原型机升级机制 (Documentation-Driven Self-Upgrade)

**核心理念**: 升级不是代码覆盖，而是Agent自主阅读升级文档并执行变更。

**单一职责原则**:
- 每次升级只解决**一个**特定问题
- 便于Clone理解升级意图和执行步骤
- 降低升级失败概率
- 多个问题应拆分为多次独立升级

**升级文档结构**:
```markdown
# Upgrade vX.Y.Z

## Why (升级原因)
- 修复了什么问题
- 增加了什么能力

## What (变更内容)
- 文件列表
- 代码变更摘要

## How (升级步骤)
1. 步骤一...
2. 步骤二...

## Code Links (代码来源)
- [file.js](https://github.com/.../file.js)
- 代码片段...
```

**升级流程**:
1. 原型机发布升级文档到指定位置
2. Clone定期检查是否有新升级
3. Clone的Upgrade Skill自动触发升级评估

**Upgrade Skill执行流程**:
```
1. 保存当前状态 (升级前快照)
   └─ git commit ~/zylos/ 和 ~/.claude/skills/
   └─ 确保有回滚点

2. 阅读和理解升级文档
   └─ 解析Why/What/How/Code Links

3. 对比当前环境和升级内容
   └─ git diff 查看本地修改
   └─ 检查memory中记录的用户修改历史
   └─ 识别用户自定义的部分

4. 冲突检测和处理
   ├─ 无冲突 → 继续
   └─ 有冲突 → 向用户确认
       ├─ 展示冲突详情 (git diff格式)
       ├─ 询问升级范围 (全部/部分/跳过)
       └─ 等待用户决策

5. 执行升级
   ├─ 制定升级plan
   ├─ 执行代码变更 (Edit/Write)
   └─ 验证变更结果

6. 记录升级结果
   └─ git commit 升级后状态
   └─ 更新upgrade-history.json
   └─ 记录当前跟踪的版本号/commit ID
   └─ 记录到memory

7. 回滚支持
   └─ 如升级失败: git checkout 回滚到步骤1的commit
```

**设计原则**: Clone可选择性升级，保护用户定制。用户的修改优先于官方升级。

### 4.5 O4: Browser Automation Interface

**职责**: 提供Web操作能力

**CLI接口** (`agent-browser`):
```bash
agent-browser --cdp <port> open <url>           # 打开URL
agent-browser --cdp <port> snapshot -i          # 获取元素列表
agent-browser --cdp <port> click @<ref>         # 点击元素
agent-browser --cdp <port> type @<ref> "text"   # 输入文本
agent-browser --cdp <port> scroll <dir> [px]    # 滚动
agent-browser --cdp <port> screenshot [path]    # 截图
```

**组件**:
- Chrome浏览器 (CDP端口)
- X11虚拟显示 (DISPLAY=:99)
- **noVNC** (Web访问)

**noVNC用途**:
- 用户通过浏览器远程查看/操作桌面
- 处理验证码、手动登录等需要人工介入的场景
- 无需安装VNC客户端，Web即可访问
- URL格式: `https://<domain>/vnc/vnc.html?path=vnc/websockify&autoconnect=true`

### 4.6 O5: Knowledge Base Interface

**职责**: 结构化知识存储和检索

**CLI接口** (`kb-cli`):
```bash
kb-cli add "title" category --content "..." --tags a,b  # 添加条目
kb-cli search "query"                                    # 全文搜索
kb-cli semantic "query"                                  # 语义搜索(RAG)
kb-cli get <id>                                          # 获取条目
kb-cli list                                              # 列出条目
```

**存储**: SQLite + FTS5全文索引 + OpenAI embeddings

---

## 5. 数据流

### 5.1 消息处理流

```
外部消息 ──► Bot (O1/O2/O3)
                │
                ▼
         格式化消息
                │
                ▼
         tmux paste-buffer ──► Claude (C1)
                                    │
                                    ▼
                              处理消息
                                    │
                                    ▼
                              send-reply.sh ──► 外部
```

### 5.2 任务调度流

```
定时触发/手动添加 ──► Scheduler (C5)
                           │
                           ▼
                     检查Claude存活 (C2)
                           │
                     ┌─────┴─────┐
                     ▼           ▼
                   崩溃        存活
                     │           │
                     ▼           ▼
                   重启      tmux paste-buffer
                                 │
                                 ▼
                           Claude执行任务
                           (busy则排队处理)
                                 │
                                 ▼
                           task-cli done
```

### 5.3 崩溃恢复流

```
Self-Maintenance (C2) ──► 检测到Claude退出
                              │
                              ▼
                         状态=STOPPED
                              │
                              ▼
                         等待10秒
                              │
                              ▼
                    tmux send-keys 'claude --resume'
                              │
                              ▼
                         状态=BUSY/IDLE
```

---

## 6. 部署配置

### 6.1 最小部署 (Core Only)

```bash
# 必需服务 (PM2) - 从skills目录启动
pm2 start ~/.claude/skills/self-maintenance/activity.js --name activity-monitor

# 必需文件
~/zylos/memory/           # Memory System (数据)
~/.claude-status          # Self-Maintenance状态
~/zylos/scheduler/scheduler.db  # Task Scheduler (数据)
```

### 6.2 标准部署 (Core + Common Optional)

```bash
# PM2服务 - 从skills目录启动
pm2 start ~/.claude/skills/self-maintenance/activity.js --name activity-monitor
pm2 start ~/.claude/skills/telegram-bot/bot.js --name telegram-bot
pm2 start ~/.claude/skills/lark-bot/bot.js --name lark-bot
pm2 start ~/.claude/skills/task-scheduler/scheduler.js --name task-scheduler
```

### 6.3 组件启用/禁用

每个Optional组件可以通过PM2独立控制:

```bash
# 禁用Telegram
pm2 stop telegram-bot
pm2 delete telegram-bot

# 启用Discord
pm2 start ~/.claude/skills/discord-bot/bot.js --name discord-bot
```

### 6.4 Claude Code 认证

Claude Code 内置交互式认证流程，支持多种认证方式。

**支持的认证方式**:

| 方式 | 凭证位置 | 适用场景 |
|------|----------|----------|
| Claude 订阅 (Pro/Max/Teams/Enterprise) | `~/.claude/.credentials.json` | 个人/团队使用 |
| Claude Console (API预充值) | `ANTHROPIC_API_KEY` 环境变量 | 生产环境、费用可控 |
| 第三方云 (Bedrock/Vertex/Foundry) | 各平台配置 | 企业云集成 |

**认证检测逻辑**:

```bash
#!/bin/bash
# check-auth.sh - 检测Claude Code认证状态

if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "authenticated"  # API方式
elif [ -f ~/.claude/.credentials.json ]; then
    echo "authenticated"  # OAuth方式
else
    echo "none"
fi
```

**部署流程**:

```
安装脚本完成
    │
    ▼
检测认证状态
    │
    ├─► 已认证 ──► 直接启动 tmux + claude --resume
    │
    └─► 未认证 ──► 提示用户运行 claude 完成首次设置
                     │
                     ▼
               Claude Code 交互式界面
                     │
                     ▼
               用户选择认证方式并完成登录
                     │
                     ▼
               启动脚本继续执行
```

**设计原则**: 复用 Claude Code 内置的认证流程，不自建认证界面。

**Headless服务器** (无GUI):
- SSH端口转发: `ssh -L 8080:localhost:8080 user@server`，本地浏览器完成OAuth
- 凭证迁移: 本地认证后复制 `~/.claude/.credentials.json` 到服务器
- 参考: https://code.claude.com/docs/en/headless

---

## 7. 组件生态 (Component Ecosystem)

### 7.1 仓库结构 (Multi-repo)

**官方仓库**:
```
zylos-ai/zylos-core        # 原型机核心代码
zylos-ai/zylos-upgrades    # 所有升级文档 (Core + 组件)
zylos-ai/zylos-registry    # 组件注册表
zylos-ai/zylos-telegram    # O1: Telegram组件
zylos-ai/zylos-lark        # O2: Lark组件
zylos-ai/zylos-discord     # O3: Discord组件
zylos-ai/zylos-browser     # O4: Browser组件
zylos-ai/zylos-kb          # O5: Knowledge Base组件
```

**社区仓库** (带命名空间):
```
kevin/zylos-whatsapp       # 社区: kevin/whatsapp
john/zylos-whatsapp-lite   # 社区: john/whatsapp-lite
alice/zylos-slack          # 社区: alice/slack
```

### 7.2 升级文档仓库 (zylos-upgrades)

所有升级文档集中管理，可引用各代码仓库的commit ID:

```
zylos-upgrades/
├── core/                  # Core升级文档
│   ├── v1.0.0.md
│   └── v1.1.0.md
├── telegram/              # 官方组件升级文档
│   └── v1.0.0.md
├── lark/
│   └── v1.0.0.md
└── README.md
```

**注意**: 社区组件(community)的升级文档由社区自己维护在各自仓库。

### 7.3 组件注册表 (zylos-registry)

**目录结构**:
```
zylos-registry/
├── registry.json           # 全局索引
├── official/               # 官方组件
│   ├── telegram.json
│   ├── lark.json
│   ├── discord.json
│   ├── browser.json
│   └── kb.json
├── community/              # 社区组件 (按作者命名空间)
│   ├── kevin/
│   │   └── whatsapp.json
│   ├── john/
│   │   └── whatsapp-lite.json
│   └── alice/
│       └── slack.json
└── README.md
```

**registry.json**:
```json
{
  "official": ["telegram", "lark", "discord", "browser", "kb"],
  "community": ["kevin/whatsapp", "john/whatsapp-lite", "alice/slack"]
}
```

**组件详情** (official/telegram.json):
```json
{
  "name": "telegram",
  "description": "Telegram Bot通讯组件",
  "type": "official",
  "repo": "zylos-ai/zylos-telegram",
  "version": "1.0.0",
  "requires_core": ">=1.0.0",
  "upgrades": "zylos-ai/zylos-upgrades/telegram"
}
```

**命名规则**:
- 官方组件: 简短名 (telegram, lark)，保留给official
- 社区组件: 命名空间 (author/component)，避免冲突

### 7.4 组件分层管理

| 类型 | 代码维护 | 升级文档 | 质量保证 |
|------|----------|----------|----------|
| official | 我们 | zylos-upgrades | ✅ |
| community | 社区 | 各自仓库 | 自负责任 |

### 7.5 组件接口规范

每个组件仓库必须提供 (符合Skills结构):
```
component-repo/
├── SKILL.md             # 组件说明 (必需，遵循Anthropic规范)
├── install.md           # 安装说明
├── config.example.json  # 配置模板 (安装时复制到~/zylos/<component>/)
├── bot.js               # 服务代码 (如需后台运行)
└── send-reply.sh        # 脚本 (如适用)
```

**通讯类组件(O1-O3)必须实现**:
- SKILL.md: 描述何时使用、如何调用
- 入站: tmux paste-buffer 发送消息给Claude
- 出站: send-reply.sh 脚本发送回复

### 7.6 组件升级机制

**组件安装时流程**:
1. 安装组件代码到 `~/.claude/skills/<component>/`
2. 创建配置目录 `~/zylos/<component>/`
3. 询问用户：是否监控该组件的升级？
4. 如果是：选择检查频率（每天/每周）
5. 添加对应的scheduled task进行定期检查

**SKILL.md升级相关字段** (在frontmatter中添加upgrade部分):

| 字段 | 说明 | 示例 |
|------|------|------|
| upgrade.repo | 升级检查的仓库 | zylos-ai/zylos-telegram |
| upgrade.version | 当前版本 | 1.0.5 |
| upgrade.check_frequency | 推荐检查频率 | daily / weekly |

**升级检查流程** (由scheduled task触发):
1. 读取组件SKILL.md中的upgrade信息
2. 检查仓库是否有新版本
3. 有新版本 → 通知用户，询问是否升级
4. 用户确认 → 执行Upgrade Skill

**Upgrade Skill执行**:
1. git commit当前状态 (回滚点)
2. 读取升级文档
3. 对比本地修改，检测冲突
4. 冲突时询问用户
5. 执行变更
6. 更新本地升级记录

**Clone本地升级记录** (`~/zylos/upgrade-history.json`):
```json
{
  "core": {"version": "1.2.0", "upgraded_at": "2026-02-01T10:00:00Z", "check": "daily"},
  "telegram": {"version": "1.0.5", "upgraded_at": "2026-02-01T10:05:00Z", "check": "weekly"},
  "kevin/whatsapp": {"version": "0.8.0", "upgraded_at": "2026-02-01T11:00:00Z", "check": "none"}
}
```

### 7.7 社区贡献流程

**发布新组件**:
1. 创建仓库，遵循组件接口规范
2. 提交PR到 zylos-registry (添加到 community/author/)
3. 基本信息审核后上架

**贡献官方组件**:
1. Fork官方组件仓库
2. 提交PR
3. 维护者审核合并
4. 发布新版本 + 在zylos-upgrades添加升级文档

---

## 8. 扩展指南

### 8.1 添加新通讯渠道

1. 在skills目录创建: `~/.claude/skills/<platform>-bot/`
2. 创建 `SKILL.md`: 描述组件用途和使用方法
3. 实现 `bot.js`: 监听消息，格式化后paste到tmux
4. 实现 `send-reply.sh`: 发送消息到平台
5. 在数据目录创建配置: `~/zylos/<platform>-bot/config.json`
6. PM2注册: `pm2 start ~/.claude/skills/<platform>-bot/bot.js --name <platform>-bot`

### 8.2 添加新能力模块

1. 在skills目录创建: `~/.claude/skills/<module-name>/`
2. 创建 `SKILL.md`: 描述模块用途和CLI接口
3. 实现功能代码和脚本
4. 配置文件放在: `~/zylos/<module-name>/config.json`
5. Claude通过SKILL.md自动获知使用方法

---

## 9. 未来演进

### 9.1 短期 (v0.1 → v0.2)

- [ ] 组件健康检查标准化
- [ ] 配置文件统一管理
- [ ] 日志收集和分析

### 9.2 中期 (v0.2 → v1.0)

- [ ] 多Agent协作接口
- [ ] 能力发现和自注册
- [ ] 资源隔离 (Docker化)

### 9.3 长期愿景

- [ ] Agent自我复制和部署
- [ ] 跨实例记忆同步
- [ ] 自主能力学习

---

## Appendix A: 当前实现状态

> 注：当前实现尚未迁移到新的skills目录结构，以下是现有位置。

| Component | Status | 现有位置 | 目标位置 (Skills) |
|-----------|--------|----------|-------------------|
| C1 Claude Runtime | ✅ Working | tmux session 'claude' | - |
| C2 Self-Maintenance | ✅ Working | ~/zylos/scheduler-v2/activity.js | ~/.claude/skills/self-maintenance/ |
| C3 Memory System | ✅ Working | ~/zylos/memory/ | ~/zylos/memory/ (数据，不迁移) |
| C4 Communication | ✅ Working | Telegram + Lark | - |
| C5 Task Scheduler | ✅ Working | ~/zylos/scheduler-v2/ | ~/.claude/skills/task-scheduler/ |
| O1 Telegram Bot | ✅ Working | ~/zylos/telegram-bot/ | ~/.claude/skills/telegram-bot/ |
| O2 Lark Bot | ✅ Working | ~/zylos/lark-agent/ | ~/.claude/skills/lark-bot/ |
| O3 Discord Bot | 🚧 In Progress | ~/zylos/discord-agent/ | ~/.claude/skills/discord-bot/ |
| O4 Browser | ✅ Working | agent-browser CLI | ~/.claude/skills/browser/ |
| O5 Knowledge Base | ✅ Working | ~/zylos/knowledge-base/ | ~/.claude/skills/knowledge-base/ |
| O6 TTS/Voice | ⏸️ Disabled | ~/zylos/telegram-bot/tts.sh | - |
| O7 HTTP Server | ✅ Working | nginx → ~/zylos/public/ | - |

---

*Document generated by Zylos - 2026-02-01*
