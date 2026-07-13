# Dev Plan: #722 P2 — 存量机迁移工具（migrate-instructions）+ A3 hook 位置归一

## Summary

为 #722 拆层机制补上第二个（也是最后一个）marker 写入者：一个把存量机的纠缠体 `~/zylos/ZYLOS.md`（系统内容 + 用户增量混写）拆分为「纯用户 ZYLOS.md + split 组装」的 CLI 迁移工具。P1（PR #723）已让存量机保守物化 + PENDING MIGRATION 提示；P2 让存量机真正激活。顺带完成 A3：激活时把 assembler SessionStart hook 位置归一到组首。

## Scope

**In：**
- 新 CLI 命令 `zylos migrate-instructions`（`cli/commands/` 新文件），默认 **dry-run**，`--apply` 才落盘。
- 三分类流水线（step-0 baseline 探测 → A/B/C 分类 → 拆分 → 守恒检查 → #717 备份 → 事务激活 → seed 元数据）。
- 历史模板语料库随包内置（含 ZYLOS 家族与 CLAUDE 家族两支 + 已知 managed 块识别器）。
- `instruction-builder.js` 新增迁移激活入口（复用 `commitEntries` 事务，marker 最后原子落盘）。
- A3：激活时把 3 条 assembler hook 条目移到 SessionStart 组首（幂等，不触碰其他 hook）。
- self-upgrade step7 的 PENDING MIGRATION 提示文案更新为指名 `zylos migrate-instructions`。

**Out（明确不做）：**
- 升级流程**不**自动触发迁移（P1 已封「升级不激活」，不重开）。
- marker 手工创建路径（R1 BLOCKER 纪律不变：写入者仅 fresh init + 本工具）。
- 删 ZYLOS.md 后的 reseed 路径（归 #727）；跨进程锁等加固项（归 #727）。
- P3 fleet 批量执行与 runbook（A4 注记随 P3）。

## Design（锚定已定决策，不重开）

1. **分类定义**（issue 研究结论，2026-07-12 双方 comment）：
   - 先剥离**已知 managed 块**：v0.4.0 migration marker 头、`zylos-managed` onboarding 块、runtime-portability 补丁行——这些内容已由系统文件/onboarding.md 承载，剥离后不算用户增量。
   - 与语料库全量 diff 取最小者（可能命中**家族**而非唯一版本，允许）：
     - **A 类**：剥离后与某历史模板逐字节一致（用户增量 0 行）→ 机械迁移：新 ZYLOS.md = 出厂空用户模板。
     - **B 类**：有唯一最小匹配，且**全部**残差行可归入用户增量 → 自动拆分：残差行成为新 ZYLOS.md 内容。
     - **C 类**：无法唯一匹配 / 残差无法完全归因 → 工具**拒绝自动拆分**，输出分析报告（候选 baseline + 残差清单）；agent 辅助整理出用户内容文件后，用 `--user-content <file>` 重跑，工具重新做守恒验证再激活。
2. **逐行守恒检查（激活硬门）**：原文件每一行必须可归因于「匹配模板 ∪ managed 块 ∪ 新用户内容」；`--user-content` 路径允许显式丢弃，但丢弃清单必须打印并写入备份目录的 `migration-report.md`。守恒不满足 → 拒绝激活、不写 marker、不动任何现有文件。
3. **#717 备份契约**：`--apply` 时先把原 ZYLOS.md / CLAUDE.md / AGENTS.md（存在者）备份到持久备份目录（复用 #717 机制与路径约定，不自动清理），备份路径打印给用户并记入 marker。
4. **事务与 marker**：所有写入走 `commitEntries` 单事务（新 ZYLOS.md、两个 output、system/onboarding/assembler 如需刷新），marker 最后落盘；marker 在 P1 字段（schemaVersion/activatedAt/seedSha256/transactionId）之上追加 `migration: {classification, matchedTemplate: {family, sha256}, originalSha256, backupPath, migratedAt}`。失败=原状保留、可重试（复用 P1 恢复判别器）。
5. **A3 归一**：`--apply` 激活成功后，若 `settings.json` SessionStart 组内存在 3 条 assembler 条目且不在组首，移动到组首（保持相对次序；其余 hook 逐字节不动；幂等）。
6. **前置状态要求**：机器须已有 P1 物化（system files + assembler 就位；无则先跑 `deployInstructionAssets` 补齐——包在手，可直接补）；pre-v0.4 机（无 ZYLOS.md）→ 明确报错引导先跑 `zylos upgrade --self`（step7 的 runMigrations 会先生成 ZYLOS.md）。已激活机 → 幂等提示「already active」退出 0。

## Development Checklist

- [ ] 语料库：从 git 历史导出 ZYLOS 家族（4 个不同 blob）与 CLAUDE 家族（5 个不同 blob）+ tag 家族映射清单，内置于包内（静态文件 + manifest）；附带一个可重跑的导出脚本以便未来版本追加。
- [ ] managed 块识别器：v0.4.0 migration marker、zylos-managed onboarding 块、runtime-portability 补丁——各配正反测试样本。
- [ ] 分类器 `classifyInstructionBaseline()`：输入用户文件内容，输出 {classification, matchedTemplate|candidates, managedBlocks, residualLines}；纯函数、路径显式传入。
- [ ] 守恒检查器：逐行归因 + 丢弃清单；不满足即抛错。
- [ ] `instruction-builder.js` 新增 `activateMigratedSplitInstructions({userContent, migrationMeta, ...})`：#717 备份 → 单事务写入（含新用户 ZYLOS.md）→ marker（P1 字段 + migration 元数据）。不改动 `activateFreshSplitInstructions` 的 legacy 拒绝门。
- [ ] CLI 命令 `zylos migrate-instructions`：dry-run 默认（零写入，输出分类 + 拟拆分预览 + 拟备份清单）；`--apply`；`--user-content <file>`（C 类）；报告写入备份目录 `migration-report.md`。
- [ ] A3 hook 位置归一（激活成功后执行；幂等；只动 3 条 assembler 条目）。
- [ ] step7 PENDING MIGRATION 提示文案指名新命令。

## Test Checklist

- [ ] fixture 三件套：A 类（v0.5.3 逐字节）、B 类（历史模板 + managed 块 + 少量用户行）、C 类（无法归因的混改）——C 类即 P1 评审遗留的 unknown-baseline 负面 fixture（F3），在此闭环。
- [ ] pre-v0.4 家族样本：旧 CLAUDE 模板 + migration marker + onboarding 块（jinglever 机的形态）→ 剥离 managed 块后正确分类。
- [ ] dry-run 零写入：跑前后全目录 hash 清单逐字节一致（含 settings.json）。
- [ ] `--apply` A/B 类：备份先落、内容与原件逐字节一致；新 CLAUDE.md/AGENTS.md = split 头 + system + 用户内容；marker migration 元数据完整；原文件每行守恒归因通过。
- [ ] C 类拒绝：不写 marker、零写入、报告输出候选与残差；`--user-content` 重跑 + 守恒通过 → 激活；`--user-content` 缺行（未声明丢弃）→ 拒绝。
- [ ] 守恒负面：注入一行无法归因内容 → 拒绝激活。
- [ ] 幂等：已激活机重跑（含 --apply）→ no-op 退出 0；再跑 A3 归一 → 零 diff。
- [ ] 事务故障注入：复用 P1 fault matrix 打迁移路径（stage/rename/marker 各点 kill）→ 原文件逐字节保留或完整提交，重试收敛；残留判别不误伤。
- [ ] A3：升级机形态（assembler 在组尾）→ 归一到组首、其余 hook 逐字节不动；fresh 形态（已在组首）→ 零 diff。
- [ ] 回归：`activateFreshSplitInstructions` legacy 拒绝门、refresh 路径、P1 全部现有测试不动且全绿（Jest + Node）。

## Assumptions

- [ ] 语料库完备性：v0.1.8 起所有 release 的 ZYLOS/CLAUDE 模板可从 git tag 枚举，且家族归并后 ZYLOS=4 blob / CLAUDE=5 blob（P1 计划已验，落地时以导出脚本重验一次）。
- [ ] managed 块的形态是有限集（migration marker / onboarding 块 / portability 补丁）——以 jinglever 机 Q2 研究为依据；若实机出现新形态，落入 C 类兜底，不会误拆。
- [ ] 存量机在 P1 升级后均已物化 system files（本机已验）；未物化者可由本工具从包内补齐，无需网络。
- [ ] `settings.json` 的 SessionStart 组结构与 P1 acceptance 记录一致（3 条 assembler 条目可整体识别）。

## Acceptance Checklist

- [ ] 沙箱：A/B/C 三类 fixture 全流程（dry-run → apply → 组装产物验证 → 幂等重跑）。
- [ ] 真机（luna.coco 机，预约的第一个真实 A 类样本）：dry-run 分类=A、零写入；`--apply` 后 CLAUDE.md=split 组装、原件备份可 diff 还原、marker 完整、A3 归一生效；下一会话生效链路正常（改 ZYLOS.md → /clear 生效）。
- [ ] C 类真实演练：构造样本走 agent 辅助 `--user-content` 全流程。
- [ ] 无回归：P1 全部测试 + 全量 Jest/Node 绿；`git diff --check` 干净。
- [ ] step7 提示文案更新可见。
