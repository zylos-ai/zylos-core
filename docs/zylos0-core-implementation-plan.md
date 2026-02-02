# Zylos0 Core 实施计划

> 日期：2026-02-02
> 状态：待Howard Review
> 测试环境：zylos-0

---

## 1. 实施范围

根据架构文档，Core层包含6个组件。当前状态：

| 组件 | 状态 | 需要做什么 |
|------|------|------------|
| C1 Claude Runtime | ✅ 已有 | tmux session已在运行 |
| C2 Self-Maintenance | ✅ 已有基础 | activity-monitor需迁移到skills目录 |
| C3 Memory System | ✅ 已有 | 目录结构已存在 |
| C4 Communication Bridge | ❌ 需新建 | **本次重点** |
| C5 Task Scheduler | ✅ 已有 | scheduler-v2需迁移到skills目录 |
| C6 HTTP Layer | ⏸️ 暂缓 | Caddy配置，非MVP关键路径 |

**本次实施重点：C4 Communication Bridge**

---

## 2. C4 Communication Bridge 实施

### 2.1 文件结构

```
~/zylos/core/                    # C4核心目录
├── c4-receive.sh               # 接收消息接口
├── c4-send.sh                  # 发送消息接口
├── c4-checkpoint.sh            # 创建检查点
├── c4-recover.sh               # 会话恢复
├── c4-db.js                    # 数据库操作 (Node.js + better-sqlite3)
├── c4.db                       # SQLite数据库
└── init-db.sql                 # 建表SQL

~/zylos/channels/                # Channel目录（约定式）
├── telegram/
│   └── send.sh                 # 封装现有telegram发送
└── lark/
    └── send.sh                 # 封装现有lark发送
```

### 2.2 实施步骤

#### Phase 1: 基础设施 (预计1-2小时)

- [ ] **Step 1.1**: 创建 `~/zylos/core/` 目录
- [ ] **Step 1.2**: 创建SQLite数据库和表结构
  ```sql
  -- conversations表：记录所有进出消息
  -- checkpoints表：记录同步点
  ```
- [ ] **Step 1.3**: 实现 `c4-db.js` 数据库操作模块
  - insertConversation(direction, source, endpoint_id, content)
  - createCheckpoint(type)
  - getConversationsSinceLastCheckpoint()

#### Phase 2: 核心接口 (预计2-3小时)

- [ ] **Step 2.1**: 实现 `c4-receive.sh`
  ```bash
  # 输入: --source telegram --endpoint 8101553026 --content "..."
  # 处理:
  #   1. 记录到DB (direction=in)
  #   2. 组装reply via路径
  #   3. tmux paste-buffer发送给Claude
  ```

- [ ] **Step 2.2**: 实现 `c4-send.sh`
  ```bash
  # 输入: telegram 8101553026 "message"
  # 处理:
  #   1. 记录到DB (direction=out)
  #   2. 调用 ~/zylos/channels/<source>/send.sh
  ```

- [ ] **Step 2.3**: 实现 `c4-checkpoint.sh`
  ```bash
  # 输入: --type memory_sync
  # 处理: 创建checkpoint记录
  ```

- [ ] **Step 2.4**: 实现 `c4-recover.sh`
  ```bash
  # 输出: 格式化的未同步对话
  ```

#### Phase 3: Channel适配 (预计1-2小时)

- [ ] **Step 3.1**: 创建 `~/zylos/channels/telegram/send.sh`
  - 封装现有 `telegram-bot/send-reply.sh` 逻辑
  - 符合标准接口: `send.sh <endpoint_id> <message>`

- [ ] **Step 3.2**: 创建 `~/zylos/channels/lark/send.sh`
  - 封装现有 `lark-agent/send-reply.sh` 逻辑
  - 符合标准接口

#### Phase 4: 集成迁移 (预计2-3小时)

- [ ] **Step 4.1**: 修改 `telegram-bot/bot.js`
  - 原：直接 tmux paste-buffer
  - 新：调用 `c4-receive.sh`

- [ ] **Step 4.2**: 修改 `lark-agent/lark-bot.js`
  - 原：直接 tmux paste-buffer
  - 新：调用 `c4-receive.sh`

- [ ] **Step 4.3**: 更新 CLAUDE.md
  - reply via 路径改为 `~/zylos/core/c4-send.sh`

- [ ] **Step 4.4**: 集成到 activity-monitor
  - 恢复时调用 `c4-recover.sh`
  - 注入未同步对话到Claude上下文

#### Phase 5: 测试验证 (预计1-2小时)

- [ ] **Step 5.1**: 单元测试
  - 数据库操作
  - 各接口脚本

- [ ] **Step 5.2**: 集成测试
  - Telegram消息进出
  - Lark消息进出
  - Checkpoint创建

- [ ] **Step 5.3**: 恢复测试
  - 模拟崩溃
  - 验证对话恢复

---

## 3. Skills目录迁移 (Phase 6, 可选)

迁移现有代码到 `~/.claude/skills/` 结构。

**优先级：中等** - 功能已工作，可在C4稳定后再迁移。

| 组件 | 当前位置 | 目标位置 |
|------|----------|----------|
| telegram-bot | ~/zylos/telegram-bot/ | ~/.claude/skills/telegram-bot/ |
| lark-bot | ~/zylos/lark-agent/ | ~/.claude/skills/lark-bot/ |
| scheduler | ~/zylos/scheduler-v2/ | ~/.claude/skills/task-scheduler/ |
| activity-monitor | ~/zylos/activity-monitor.sh | ~/.claude/skills/self-maintenance/ |

---

## 4. 待确认事项

在开始实施前，请Howard确认：

### 4.1 技术决策

1. **数据库位置**：`~/zylos/core/c4.db` 还是 `~/zylos/data/c4.db`？
2. **paste-buffer策略**：是否继续使用unique buffer name防止竞争？
3. **消息格式兼容**：是否需要支持现有格式的平滑迁移？

### 4.2 实施策略

1. **在哪个环境先实施**？
   - A) zylos-0测试服务器（推荐，隔离测试）
   - B) 本地zylos（风险：可能影响当前工作）

2. **是否需要回滚方案**？
   - 建议：先git snapshot，确保可回滚

3. **Skills迁移是否在MVP范围**？
   - 建议：C4稳定后再迁移，降低变更风险

---

## 5. 预估工时

| Phase | 内容 | 预估 |
|-------|------|------|
| 1 | 基础设施 | 1-2小时 |
| 2 | 核心接口 | 2-3小时 |
| 3 | Channel适配 | 1-2小时 |
| 4 | 集成迁移 | 2-3小时 |
| 5 | 测试验证 | 1-2小时 |
| **总计** | | **7-12小时** |

分阶段交付，每个Phase完成后可验收。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 迁移过程中消息丢失 | 高 | 保持旧路径兼容，渐进迁移 |
| paste-buffer竞争 | 中 | 继续使用unique buffer name |
| 数据库损坏 | 中 | 定期备份，WAL模式 |
| 回滚困难 | 中 | 实施前git snapshot |

---

## 7. 成功标准

C4实施完成的验收标准：

1. ✅ Telegram消息能通过C4收发
2. ✅ Lark消息能通过C4收发
3. ✅ 所有消息记录在SQLite中可查
4. ✅ memory-sync时创建checkpoint
5. ✅ 崩溃恢复能获取未同步对话
6. ✅ 不影响现有功能

---

*计划制定：Zylos*
*日期：2026-02-02*
