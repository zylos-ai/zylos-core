# Dev Plan: self-upgrade success path deletes conflict backups (#717) — v3

> v3 (post plan-review R2, jinglever): 修正 D4 失败语义与当前明确契约对齐（post-install finalizer 失败**不回滚**，`cb2350a` 主动决策 + 既有测试锁定）。
> v2 (post plan-review R1, jinglever): 吸收 2 个 P2（跨版本交接可见性、self-upgrade 测试 seam）与 4 项边界修正。R1/R2 全部发现均接受，无 pushback。变更点见文末 Changelog。

## Summary

修复升级流程中最后一个静默丢数据的口子：self-upgrade 非 JSON 成功路径会把冲突备份连同临时备份目录一起删除，且不打印冲突文件路径；顺带修掉内容逐字节相同仍被判 conflict 的误报。Issue: zylos-ai/zylos-core#717（双机实测 + 双人源码核实，Howard 已拍板发版前收敛）。

## Scope

**In scope**
- 冲突备份与临时事务回滚备份的生命周期分离（问题 A）
- 冲突路径可见性：**必须经由新 finalizer 可控、旧 launcher 已会展示的兼容通道**（问题 A，见 P2-1 决策）
- `!savedHash` 分支内容相等短路（问题 B）——注意这是 smartSync 共享路径修复，**会同时改变 component upgrade 的假冲突行为**，属预期收益，需一并测试确认
- 上述行为的回归测试（含专用 self-upgrade 测试 seam）

**Out of scope**
- JSON 分支行为（现状正确：`mergeConflicts[].backupPath` 输出明细、成功分支不调 `cleanupBackup`——R1 已复核 `component.js:1134-1159`）——仅回归确认不被破坏
- component upgrade 的 A 类备份生命周期（R1 已扫：`cli/lib/upgrade.js` 用 `<skill>/.backup/<timestamp>`，无成功后 cleanup，无同类缺陷）
- 备份保留策略/自动清理旧冲突备份（后续单开 issue）
- 进度计数 /12→/13 跨版本交接现象（已定性非缺陷，不处理）

## Design Decisions

### D1 — 冲突备份落点：`$ZYLOS_DIR/.backup/<timestamp>/conflicts/<skill>/<file>`

- **基于 `ZYLOS_DIR`，不硬编码 `~/zylos`**（自升级与测试正式支持自定义 ZYLOS_DIR）
- 根级集中目录：self-upgrade 跨多个 core skill，一次 review 全部冲突；与 `/tmp` 事务 rollback 快照彻底分开
- 无冲突时由 smartSync 懒创建，不留空目录
- 理由：回归 `references/upgrade.md` 文档契约（本来就写 `.backup/`），脱离易失 /tmp
- （已在 #695 群向 Howard 报备，无异议）

### D2 — 路径可见性走 step message 兼容通道（P2-1）

真实 self-upgrade 是跨版本交接：旧版 `component.js` launcher 持有 `printStep` 与最终输出（`component.js:1125-1161`），step4 装新包后新版 finalizer 只返回 steps/result（`self-upgrade.js:1616-1628`）。**只改新版 component.js 的最终汇总，首次从缺陷版本升到修复版本时不生效**——而这恰是最需要保护的一次。

因此：**step5 `sync_core_skills` 返回的 `message` 本身携带每条 `skill/file → backupPath`**；旧 `printStep()` 无条件显示 `step.message`（`component.js:31-39`），首次升级即可见。JSON 模式不传 `onStep`，不会重复输出。新版 component.js 的最终汇总可作为补充，但**不得作为唯一通道**。

### D3 — 不新增 public `conflictBackupDir` result 字段

`mergeConflicts[].backupPath` 已是 JSON、CLI 与 re-merge 的完整接口，无真实新消费者。冲突备份根路径只在 step5 局部 / ctx 内部使用，不加重复 public 字段。

### D4 — 失败语义：持久冲突备份一经写入即保留；post-install 失败不回滚（对齐现契约）

当前明确契约（非遗漏，`cb2350a` 主动决策 "avoid rollback after finalizer handoff"，`self-upgrade.js` finalizer 失败路径 `buildSelfUpgradeResult(..., null, false)` 不调 `rollbackSelf()`，既有测试 `self-upgrade.test.js` 锁定 `fails without rollback` / `{performed:false, steps:[]}`）：

- **step6+（post-install finalizer 内）任一步失败 → 不做 rollback**；成功 cleanup 不运行 → **临时 backupDir 保留，持久 conflict backup 也原样保留**。本 PR 不改变该契约，不重新引入 post-install rollback。
- 「临时事务 backupDir 负责 rollback」**仅限 pre-finalizer / pre-install 失败路径**（step1-4，旧 launcher 内 `rollbackSelf()`），不暗示 post-install 会回滚。
- 持久 conflict backup 一经写入即保留（安全优先），任何失败模式下都不清理。

## Development Checklist

- [ ] `cli/lib/self-upgrade.js` step5：`conflictBackupDir = $ZYLOS_DIR/.backup/<ts>/conflicts/`（独立于 `ctx.backupDir`，懒创建）；step result `message` 逐条携带 `skill/file → backupPath`（D2）
- [ ] `cli/lib/smart-merge.js`：`!savedHash` 分支先比较 `currentHash === newHash`，相等则不冲突、不备份、不改内容（归类按现有语义最贴近者，倾向 `overwritten` 或新加 `unchanged` 计数——以实现最小侵入为准，测试锁行为不锁归类名）
- [ ] `cli/commands/component.js` 新版非 JSON 成功分支：补充最终汇总输出 `mergeConflicts` 明细（作为 D2 的补充通道）
- [ ] `cleanupBackup(result.backupDir)` 保持现行为（只删临时事务备份）；确认删除范围不含新落点
- [ ] 无冲突时不产生 `.backup` 冲突目录
- [ ] `component-management/references/upgrade.md` 措辞与 `$ZYLOS_DIR/.backup/<ts>/conflicts/` 落点对齐

## Test Checklist

**专用 self-upgrade 测试 seam（P2-2）**：不得复用 `test/helpers/run-upgrade-driver.mjs`（它驱动 component `runUpgrade()`，不经过 step4 安装/新 finalizer/旧 launcher `printStep`/成功 `cleanupBackup`）。需新建/扩展一个 self-upgrade driver：依赖注入 npm-install、PM2、`ZYLOS_DIR`（临时目录），不污染宿主全局环境；能模拟 old-launcher → new-finalizer 交接。

- [ ] **问题 A 用真正三方冲突构造**：已有 baseline v1，local 与 upstream 对同一内容分歧（不得用 `!savedHash + 内容不同` 代替——那会让 A、B 压在同一分支上无法独立定位）
- [ ] ≥2 个冲突文件、含嵌套路径，证明"逐条输出"非单例偶然
- [ ] old-launcher → new-finalizer 契约测试：旧 `printStep` 路径下，step5 message 已含全部 `file → backupPath`（首次升级即可见）
- [ ] 成功清理临时 `backupDir` 后，持久 conflict backup 仍存在
- [ ] **负控**：以上 A 类测试在父提交 `81d10647` 上必须按预期失败，候选上通过
- [ ] **问题 B 独立 discriminator**：`!savedHash + currentHash === newHash` → 不冲突、不备份、不改内容
- [ ] B 的共享路径收益确认：component upgrade 路径上同构造同样不再报假冲突
- [ ] later-failure 测试（D4，按现契约断言）：step5 有冲突、step6+ 失败 → `result.rollback.performed === false`；临时 backupDir 与持久 conflict backup **两个目录均存在**；持久备份内容未变。不断言任何回滚行为
- [ ] JSON 模式回归：`mergeConflicts[].backupPath` 指向新落点且文件存在；JSON 分支仍不清理（既有行为）
- [ ] 全量：Jest + node 套件全绿（基线 141/141 + 687/687，允许新增测试增长）

## Assumptions（R1 已逐条复核确认）

- [x] `ZYLOS_DIR` 存在且可写 —— 成立；**实现必须基于 `ZYLOS_DIR`，不硬编码**
- [x] 临时 `backupDir` 成功后无内部读方 —— 成立（读方为 finalize state 交接、`rollbackSelf()`、result 暴露与非 JSON 成功 cleanup；成功结束后无恢复消费者）。JSON 现状保留临时 backupDir 属既有行为，不改
- [x] JSON 分支不调 `cleanupBackup` —— 成立（`component.js:1134-1159` JSON 分支；cleanup 仅在非 JSON `else if (result.success)` `1160-1184`）
- [x] `currentHash`/`newHash` 在 `!savedHash` 分支可用 —— 成立（循环源自 `newManifest.files`，dest 已存在，saved manifest 存在时 current manifest 已生成；二进制/大文件同走 hash）

## Acceptance Checklist

- [ ] 验收点 1（问题 A）：真机构造真正三方冲突跑 self-upgrade，成功后冲突备份存活于 `$ZYLOS_DIR/.backup/<ts>/conflicts/`，**首次升级路径（旧 launcher）stdout 即列出文件与备份路径**
- [ ] 验收点 2（问题 B）：构造 manifest 未登记但内容与包内一致的文件，升级后不报 conflict、不产生备份
- [ ] 临时 backupDir 成功后仍被清理（现行为无回归）
- [ ] 全量测试通过（Jest + node），A 类负控在父提交红
- [ ] `git diff --check` 干净
- [ ] 无 UI 面，无需浏览器验证

## Changelog

- **v3**（R2 修订，接受 jinglever 唯一 P2）：D4 与 later-failure 测试对齐现实契约——post-install finalizer 失败不回滚（`cb2350a` 主动设计，测试已锁定），失败时临时 backupDir 与持久 conflict backup 均保留；测试断言 `rollback.performed === false` + 双目录存在 + 持久备份内容未变；「临时备份负责 rollback」限定 pre-install 路径。不重新引入 post-install rollback、不扩大 #717 范围
- **v2**（R1 修订，全部接受 jinglever 发现）：
  - P2-1 → 新增 D2：路径可见性改走 step5 message 兼容通道 + old-launcher→new-finalizer 契约测试（原计划只改新版 component.js，首次升级不生效）
  - P2-2 → Test Checklist 重写：专用 self-upgrade 测试 seam；A 用真正三方冲突（不与 B 共享 discriminator）；≥2 冲突文件含嵌套路径；负控绑定父提交 `81d10647`
  - 落点统一为 `$ZYLOS_DIR/.backup/<ts>/conflicts/<skill>/<file>`（不硬编码 ~/zylos）
  - 删除"透出 public conflictBackupDir 字段"（D3，无真实消费者）
  - 新增 D4 失败语义 disposition + later-failure 测试
  - Scope 修正：component upgrade A 类生命周期已扫无同类缺陷（out of scope），B 短路是共享修复、component 路径收益 in scope 并测试确认
- **v1**：初版
