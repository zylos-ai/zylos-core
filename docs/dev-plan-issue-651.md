# Dev Plan: SessionStart Hook 迁移逻辑 registry 重构 (#651 / PR #668)

> 设计共识文档（权威，含完整 rationale + 决策记录）：
> https://luna.jinglever.com/pages/s/d298490c9bd168607a653a759b641085
> 本 dev plan 是该设计的**可执行契约**——只列"做什么 / 怎么测 / 怎么验收"，rationale 见上文。

## Summary

把 `cli/lib/sync-settings-hooks.js` 里 SessionStart hook 的"所有权判断"从 **template 反推 `coreSkillNames`** 换成 **源码内 append-only 的 `CORE_MANAGED_HOOKS` 注册表**（path-only）。一次根治当前迁移逻辑的"补丁叠补丁"，并消除 2 个 bug + 1 个盲区。直接落在 **PR #668**，使其成为一个完整自洽的 PR。

## Scope

**In scope（本次 PR #668）：**
- 新增**单一导出的规范化 path-key helper** `hookScriptKey(command)`（`hook-utils.js`），定义 registry 使用的 canonical 后缀/键；所有所有权/路径身份判断统一走它
- 新增 `CORE_MANAGED_HOOKS` 注册表 + `isCoreManaged()`（基于 `hookScriptKey`），作为唯一所有权事实源
- 引擎 A（`sync-settings-hooks.js` 声明式 sync）所有权判断切到 registry，删除 `coreSkillNames` 收集步；私有 `scriptPathEndsWith` 并入共享 helper
- **`self-upgrade.js` 第二条所有权入口同步切到 registry**（plan-review P1）：`generateMigrationHints()` 的 removed-hook 所有权判断 + `applyMigrationHints()` 的路径匹配都复用同一 registry / `isCoreManaged()` / `hookScriptKey`。**决策：保留 shell-out + fallback 机制，但 fallback 路径也走 registry（不废弃，只对齐）**——否则 fallback 时仍是 template 反推、退役 hook 漏判
- 删除引擎 B 全部专用迁移补丁（registry 下引擎 A 已能覆盖今天的两个迁移）
- 单测（含 `self-upgrade.test.js` hint 覆盖）+ 现有 real-smoke 端到端用例验证

**Out of scope（明确不做）：**
- **Codex runtime（#652）**：不在本次；不做 runtime 无关抽象，registry 就是 Claude `settings.json` 的 core hook 路径表（Howard 决策）
- 「结构性迁移」引擎 B 的**位置**保留为定义清晰的空扩展 seam，但本次**不放任何实际迁移逻辑**（留给将来字段级数据迁移 / 跨 event 非 1:1 重组）
- 不改 SessionStart 之外的 hook 行为

## Development Checklist

- [ ] **新增并导出单一 canonical path-key helper**（plan-review P2，**先做，它是 registry 的地基**）：在 `hook-utils.js` 新增 `hookScriptKey(command)`（或 `normalizeHookScriptPath`），输出 = registry 使用的规范化后缀/键。把现 `sync-settings-hooks.js` 私有 `scriptPathEndsWith`（line 610-612）的归一化逻辑收进这个 helper。**所有所有权 / 路径身份判断的入口统一用它**：`CORE_MANAGED_HOOKS`、`isCoreManaged()`、sync forward/reverse、`generateMigrationHints()`、`applyMigrationHints()`——禁止任一入口再用裸 `extractScriptPath()` 做 equality（消除"两套 key 语义"）
- [ ] **新增注册表** `CORE_MANAGED_HOOKS`（`cli/lib/sync-settings-hooks.js` 或拆到 `hook-utils.js`，由实现者定）：
  - 内容 = **当前 template 所有 event 下的全部 hook 脚本路径** ∪ **历史退役路径**（即现有 `SESSION_START_OLD_SCRIPTS` 的 4 条：`skills/zylos-memory/scripts/session-start-inject.js`、`skills/comm-bridge/scripts/c4-session-init.js`、`skills/activity-monitor/scripts/session-foreground.js`、`skills/activity-monitor/scripts/session-start-prompt.js`）
  - 当前 template SessionStart 已是单 orchestrator：`skills/activity-monitor/scripts/session-start-orchestrator.js`（startup/clear/compact 三组）
  - 存**规范化后缀路径**（沿用现有 `extractScriptPath` + `scriptPathEndsWith` 的归一化口径，`split(path.sep).join('/')`）
  - **append-only 注释约定**：退役 hook 的路径**保留不删**，新增 core hook 时追加一行
- [ ] **新增 `isCoreManaged(hook)`**：`CORE_MANAGED_HOOKS` 命中 `normalize(extractScriptPath(hook.command))` → bool。非 command 类型 hook（无 `command`）→ 取不到 path → 返回 false（默认保留）
- [ ] **引擎 A reverse pass 切换所有权判断**（line ~387-388）：
  - 从 `const skillName = extractSkillName(h.command); if (!skillName || !coreSkillNames.has(skillName)) continue;`
  - 改为 `if (!isCoreManaged(h)) continue;`
- [ ] **删除 `coreSkillNames` 收集步**（line ~273-279）及其对 `extractSkillName` 的依赖（若别处不再用，连 import 一起清）
- [ ] **删除引擎 B 专用迁移补丁**：
  - 常量 `SESSION_START_OLD_SCRIPTS`（line 34）、`SESSION_START_OLD_TIMEOUT_BY_SCRIPT`（line 40）→ 被 registry 取代后删除（注意：registry 需吸收这 4 条退役路径）
  - 函数 `migrateMatcherSplit`（line 552）、`migrateSessionStartOrchestrator`（line 659）、`isOrchestratorTemplate`（615）、`isStandardOldSessionStartGroup`（629）、`containsOldSessionStartScript`（643）
  - `skipEvents` 全部 plumbing（line 292-301、309、369 等）——SessionStart 不再被摘出引擎 A
  - `SESSION_START_MATCHERS`（line 46）：若仅迁移代码用，删；若别处复用，保留
- [ ] **确认引擎 A forward pass 无需改**（line 308-362 仍按 (event,matcher,path) 对齐 add/update），仅 reverse 的所有权判断变了
- [ ] **确认空组 / 空 event 清理逻辑保留**（reverse 末尾），且仅在组内全部 hook 被删时触发
- [ ] **`self-upgrade.js` 第二条所有权入口对齐**（plan-review P1）：
  - `generateMigrationHints()`（line 401~）：删除 `coreSkillNames` 收集（430-436）；removed-hook 所有权判断（533-534 的 `extractSkillName`+`coreSkillNames.has`）改为 `isCoreManaged()`；template/installed 路径身份匹配（448-454、536-539）改用 `hookScriptKey`
  - `applyMigrationHints()`（line 895~）：路径匹配（955-962、1004-1012）改用 `hookScriptKey`
  - `runSettingsHookSync()`（1088~）：**保留** shell-out 到新装 `sync-settings-hooks.js` + fallback 到 `generateMigrationHints/applyMigrationHints` 的结构；fallback 现在走 registry，所以 fallback 也不再失忆（**不废弃该 fallback**）
- [ ] 自检：删除后无悬挂 import / 无对已删函数的引用（`grep` 验证）——**`grep` 范围含 `sync-settings-hooks.js` 与 `self-upgrade.js` 两处**，确认无残留 `coreSkillNames` / template 反推 ownership / 裸 `extractScriptPath` equality

## Test Checklist

- [ ] **registry 完整性单测**：断言 `当前 template 内每个 event/matcher 下每个 command hook 的路径 ∈ CORE_MANAGED_HOOKS`（防将来加 hook 漏维护 registry）
- [ ] **迁移场景单测**（升级旧实例 → 收敛到当前 template）：
  - [ ] catch-all 空 matcher `""`（旧 4-hook 形态）→ startup/clear/compact 各一个 orchestrator
  - [ ] 旧 4-hook → 1 orchestrator（4→1 collapse）
  - [ ] **Bug #1 回归**：用户改过旧 hook 的 timeout（如非标准值）→ 仍正确迁移（不再因 timeout 不匹配而冻结）
  - [ ] **Bug #2 回归**：旧实例只有 3 个 hook（非恰好 4 个）→ 仍正确迁移（不再因 count≠4 冻结）
  - [ ] orchestrator timeout 漂移 → forward update 回 template 值
  - [ ] orchestrator 换脚本（v1→v2 路径，模拟未来）→ 删旧加新
- [ ] **保留性单测**：
  - [ ] 用户自定义 hook（不在 registry）→ 保留，不被删
  - [ ] **非 command 盲区回归**：`type:'url'` 等非 command hook → `isCoreManaged` 取不到 path → 默认保留，不被静默丢失
  - [ ] 组内混合（用户 hook + core hook）→ 只删 core，组不被误删
- [ ] **空组清理单测**：组内 core hook 全删 → 组移除；event 下组全空 → event 键移除；组内仍有用户 hook → 组保留
- [ ] **幂等性单测**：installed == template 时再跑 sync → 无变更
- [ ] **canonical key helper 回归**（plan-review P2）：`hookScriptKey` 命中**不依赖** full command / `~/` 形式（同一脚本不同书写 → 同一 key）；若覆盖 separator 语义则用显式 backslash fixture 验证
- [ ] **`self-upgrade.test.js` hint 覆盖**（plan-review P1）：
  - [ ] 退役 SessionStart hook（在 registry、不在当前 template）→ `generateMigrationHints` 生成 `removed_hook`
  - [ ] 非 command / 用户自定义 hook（不在 registry）→ **不**生成 removed hint
  - [ ] fallback 路径（`runSettingsHookSync` 走 `generateMigrationHints/applyMigrationHints`）的所有权判断与 `sync-settings-hooks.js` 一致（同一 registry，无失忆）
- [ ] **保留并通过现有 real-smoke 端到端用例**（`test:` 系列，line 见近期 commit）
- [ ] `make ci` / `npm test` 全绿（本地先过，含需要的依赖安装）

## Assumptions

- [ ] **脚本路径是 hook 所有权的稳定标识**：core hook 的脚本相对路径（规范化后缀）在版本间稳定、可作 registry key。— 由我们自己掌控（脚本由 core 发布），成立。
- [ ] ~~路径归一化口径一致~~ **已升级为实现约束（不再是假设）**：plan-review P2——归一化由单一导出 helper `hookScriptKey` 强制，所有入口（registry / `isCoreManaged` / sync / `self-upgrade.js`）共用，从机制上排除"两套 key 语义"。
- [ ] **非 command hook 无可解析 command path**：故 `isCoreManaged` 对其返回 false、默认保留。— 符合"我们只认领自己装的 command 脚本"语义。
- [ ] **退役路径不与用户脚本撞名**：用户不会把自定义脚本命名成我们退役的精确路径后缀。— 与现状同一边界（现也靠精确后缀匹配），可接受。
- [ ] **当前 template SessionStart 已是 orchestrator 形态**（startup/clear/compact × 1 orch）——已确认。

## Acceptance Checklist

- [ ] 所有权判断走 registry，`coreSkillNames` 收集步与引擎 B 专用迁移代码已删净——**`grep` 跨 `sync-settings-hooks.js` + `self-upgrade.js` 两处**确认无 template 反推 ownership / 无裸 `extractScriptPath` equality 残留
- [ ] `self-upgrade.js` 两条所有权入口（hint 生成 + apply）走同一 registry + `hookScriptKey`；focused `self-upgrade.test.js` hint 覆盖通过
- [ ] 三类历史实例升级均正确收敛到当前 template：catch-all 4-hook / 旧 4-hook 多 matcher / 含非标准 timeout 或非 4 count 的旧实例
- [ ] Bug #1（timeout 冻结）、Bug #2（count≠4 冻结）、非 command 盲区——均有回归测试覆盖且通过
- [ ] 用户自定义 hook（含非 command 类型）零丢失
- [ ] 幂等：重复 sync 无副作用
- [ ] `make ci` 本地全绿；GitLab/GitHub CI 全绿
- [ ] Lint clean
- [ ] PR #668 描述更新为"完整 registry 重构版"，收口 #651
- [ ] 非 UI 改动，无需浏览器验证

## Roles（per dev-workflow）

- **PM / QA / dev plan / acceptance**：Luna（zylos01）
- **Developer**：Jinglever
- **Code Reviewer**：zylos0t（+ Luna 独立 review）
- **Decision maker**：Howard
