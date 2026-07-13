# Dev Plan: #722 P2 — 存量机迁移工具（migrate-instructions）+ A3 hook 位置归一

> R1（jinglever s1 review, task comment `f971e195`）后修订版：4 个阻塞项全部采纳
> （①catalog 范围、②B 类判定、③守恒/丢弃矛盾、④A3 收敛），并吸收 4 项验证边界。

## Summary

为 #722 拆层机制补上第二个（也是最后一个）marker 写入者：一个把存量机的纠缠体 `~/zylos/ZYLOS.md`（系统内容 + 用户增量混写）拆分为「纯用户 ZYLOS.md + split 组装」的 CLI 迁移工具。P1（PR #723）已让存量机保守物化 + PENDING MIGRATION 提示；P2 让存量机真正激活。顺带完成 A3：assembler SessionStart hook 位置归一到组首。

## Scope

**In：**
- 新 CLI 命令 `zylos migrate-instructions`（`cli/commands/` 新文件），默认 **dry-run**，`--apply` 才落盘。
- 分类流水线（step-0 baseline 探测 → A/C 分类（自动 B 预期为空集，见 Design 2）→ 拆分 → 逐行守恒检查 → 持久备份 → 事务激活 → seed 元数据）。
- 历史模板语料库随包内置（**全部可达历史 blob**，非 tag-only，见 Design 1）+ 已知 managed 块识别器。
- `instruction-builder.js` 新增迁移激活入口（复用 `commitEntries` 事务，marker 最后原子落盘）。
- A3：激活时归一 assembler hook 位置；**已激活机重跑也必须检测并收敛 A3**（见 Design 5）。
- self-upgrade step7 的 PENDING MIGRATION 提示文案更新为指名 `zylos migrate-instructions`。

**Out（明确不做）：**
- 升级流程**不**自动触发迁移（P1 已封「升级不激活」，不重开）。
- marker 手工创建路径（写入者纪律不变：仅 fresh init + 本工具）。
- **内容销毁/丢弃协议**：本 P2 无任何丢弃豁免（见 Design 3）；若未来确需允许销毁原始内容，须 Howard 另批一个明确、可审计的 owner declaration 协议，不在本期。
- 删 ZYLOS.md 后的 reseed 路径（归 #727）；跨进程锁等加固项（归 #727）。
- P3 fleet 批量执行与 runbook（A4 注记随 P3）。

## Design（锚定已定决策；R1 修订处已标注）

1. **语料库（R1-① 修订，对齐冻结 P1 plan L73）**：catalog = **全 repo 可达历史**中 `templates/ZYLOS.md` + `templates/CLAUDE.md` 的全部 distinct blobs（`git rev-list --all` 枚举每个 commit 的两个 path，ls-tree 取 blob 去重；不用带 history-simplification 的 path-filtered log）。manifest 记录每个 blob 的 sha256 + 首见 commit/tag 来源。**catalog 不承诺完备**——branch install/upgrade 是正式路径（README `install.sh --branch`、branch self-upgrade），已删分支/不可达 commit 也可能 seed 过机器；文档与工具输出都不得宣称覆盖所有 seed。导出脚本入库，可重跑追加。（参考基数：P1 记录 legacy ZYLOS=22；tag-only 只有 4/5，**不足以支撑分类**。）
2. **分类定义（R1-② 修订，对齐冻结 P1 plan L55/L74——反循环证明）**：
   - 先剥离**已知 managed 块**：v0.4.0 migration marker 头、`zylos-managed` onboarding 块、runtime-portability 补丁行。
   - **A 类**：剥离后与 catalog 某 blob **逐字节一致** → 机械迁移（新 ZYLOS.md = 出厂空用户模板）。A 的判据是**内容级证明**，与 provenance 无关：即使真实 seed 是不可达版本，内容相同即无风险。
   - **自动 B 类**：仅当存在**独立于 diff 的 authoritative provenance 证据**（已记录 seed hash / 可验证安装 manifest / `.zylos/originals` 记录）精确命中 catalog，且残差 hunks 全部为可证纯新增，才允许自动拆分。**「catalog 内唯一最小 diff / unique pure-add 残差」本身不构成证据**（循环证明反例：不可达真实模板 = candidate+X 时，X 会被错归为用户内容并造成双重系统段）。现实中 legacy 机没有任何 provenance ledger → **接受自动 B 集合为空**。
   - **C 类**（其余全部）：工具**拒绝自动拆分**，输出分析报告（候选 baseline 排名 + 残差清单，仅供参考）；agent 辅助整理出用户内容文件后，用 `--user-content <file>` 重跑，工具重新做守恒验证再激活。
3. **逐行守恒检查（R1-③ 修订：删除丢弃豁免）**：激活硬门。基于 **occurrence/edit-script**（保序、计数），不是 line-membership 并集。原文件每一行（含重复行的每次出现）必须可归因于「匹配/候选模板 ∪ managed 块 ∪ 新用户内容」；**没有任何丢弃豁免**——非 managed 且不归因于模板的内容必须落入用户内容（`--user-content` 只提供用户目的地，不提供销毁能力）。不想要的行，迁移后由 owner 在自己的 ZYLOS.md 里正常编辑删除（用户文件用户主权，工具不代行销毁）。守恒不满足 → 拒绝激活、不写 marker、不动任何现有文件。边界明确处理：CRLF、无末行换行、managed marker 截断/嵌套/形似（lookalike）不误吞。
4. **持久备份契约（R1 验证边界落实；#717 是契约先例而非可复用 helper——现实现仅 `self-upgrade.js:641` 为 smart-merge conflicts 内联建 `.backup/<ts>/conflicts`）**：本工具自建布局 `~/zylos/.backup/<timestamp>/instruction-migration/`，内含原 ZYLOS.md / CLAUDE.md / AGENTS.md（存在者全备）+ `migration-report.md`（分类、归因表、候选清单）。**全部 copy 成功并校验后才允许任何 live mutation**；任一 copy 失败 → 零改动退出。备份在成功/失败/重试后都保留（不自动清理，同 #717 语义）；打印路径 = marker.backupPath = 实际目录；与事务临时件 `.split-txn.*.bak` 严格分离（路径与清理器都不相交）。
5. **事务、marker 与 A3 收敛（R1-④ 修订）**：所有 instruction 写入走 `commitEntries` 单事务（提交点 = marker rename，`instruction-builder.js:210`），marker 追加 `migration: {classification, matchedTemplate:{sha256, source}, originalSha256, backupPath, migratedAt}`。A3（settings.json 归一）在 marker 提交后执行，属**另一失败域**——因此规定：**本命令在已激活机上重跑不是纯 no-op**，而是「检测 A3 归一状态 → 未归一则收敛（幂等）→ 报告 already-active 退出 0」。marker 提交后 settings 写失败/进程被杀 → 重跑必然修复，修复后再跑零 diff。A3 只移动 3 条 assembler 条目到 SessionStart 组首（保持相对次序）；所有非目标 hook 深度相等 + 顺序不变。
6. **前置状态要求**：机器须已有 P1 物化（无则先 `deployInstructionAssets` 从包内补齐）；pre-v0.4 机（无 ZYLOS.md）→ 明确报错引导先跑 `zylos upgrade --self`（step7 runMigrations 先生成 ZYLOS.md）。

## Development Checklist

- [ ] 语料库导出脚本（`git rev-list --all` 全可达枚举、双 path、blob 去重、manifest 含 sha256+来源）+ 语料库静态文件入包；脚本可重跑、幂等。
- [ ] managed 块识别器（migration marker / onboarding 块 / portability 补丁），含截断/嵌套/lookalike 负例的防误吞处理。
- [ ] 分类器 `classifyInstructionBaseline()`：输出 {classification: A|C（+ ledger 命中时 B）, matched|candidates, managedBlocks, residual}；纯函数、路径显式传入；自动 B 仅走 provenance ledger 分支。
- [ ] 守恒检查器：occurrence/edit-script 保序计数归因；无丢弃分支；CRLF/末行/marker 边界处理。
- [ ] 备份模块：`.backup/<ts>/instruction-migration/` 布局、先备份后改动、copy 校验、任一失败零 mutation、报告落盘。
- [ ] `instruction-builder.js` 新增 `activateMigratedSplitInstructions({userContent, migrationMeta, ...})`：单事务写入（含新用户 ZYLOS.md）→ marker（P1 字段 + migration 元数据）。不触碰 `activateFreshSplitInstructions` 的 legacy 拒绝门。
- [ ] CLI 命令 `zylos migrate-instructions`：dry-run 默认（零写入）；`--apply`；`--user-content <file>`；已激活机重跑 = A3 收敛 + already-active 退出 0。
- [ ] A3 归一实现（激活后执行 + active-rerun 收敛路径共用同一幂等函数）。
- [ ] step7 PENDING MIGRATION 提示文案指名新命令。

## Test Checklist

- [ ] fixture：A 类（catalog blob 逐字节，含一个**非 tag、仅 branch 历史可达**的 blob 样本）/ C 类（无法归因混改）/ pre-v0.4 家族样本（旧 CLAUDE 模板 + migration marker + onboarding 块，jinglever 机形态）→ 剥离 managed 块后正确分类。
- [ ] **unknown-baseline 负面 fixture（P1 plan L55 恢复）**：「不可达真实模板 = candidate + X，当前文件 = 真实模板 + 用户 Y」→ 必须判 C，X 不得被归为用户内容，catalog 内唯一 pure-add **不得**自动升 B。
- [ ] provenance-ledger B 类正例（构造 recorded seed hash 命中）→ 自动拆分成立；同样本去掉 ledger → 判 C。
- [ ] 守恒负面：注入无法归因行 → 拒绝；omitted / duplicated / reordered identical lines（membership 并集会漏检的三类）→ 拒绝；CRLF、无末行换行、managed marker 截断/嵌套/lookalike → 不误吞不误放行。
- [ ] `--user-content` 缺行（原始非 managed 内容未落入用户文件）→ 拒绝，无丢弃出口。
- [ ] dry-run 零写入：跑前后全目录（含 settings.json、.backup）hash 清单逐字节一致。
- [ ] `--apply` A 类：备份先落且逐字节可还原；新 CLAUDE.md/AGENTS.md = split 头 + system + 用户内容；marker migration 元数据完整；守恒归因表落报告。
- [ ] 备份失败注入（copy 中途失败）→ 零 mutation、明确报错、可重试。
- [ ] **事务故障矩阵（逐 entry 精确列举，不笼统写「复用 P1」）**：user ZYLOS / claude-system / codex-system / onboarding / assembler / claude-output / codex-output / marker 八项，覆盖 stage 后 kill、rename 中 kill（old→txn-backup 后、new→live 后）、rollback remove/restore 失败、commit 后 cleanup 失败 + 重试判别收敛；原文件逐字节保留或完整提交，二态无中间残留。
- [ ] **A3 故障与收敛**：marker 提交成功 → settings 写失败/kill → 重跑修复 → 再跑零 diff；已激活机直接重跑（含从未做过 A3 的 active 机）→ 收敛。
- [ ] **A3 保护面**：所有非目标 hook 深度相等 + 顺序断言；foreign lookalike 条目、重复 assembler、缺失 assembler、多个 SessionStart matcher group 各一例。
- [ ] **CLI 真入口**：子进程执行 `cli/zylos.js migrate-instructions` 的 dispatch、flags、stdout/stderr、exit code（现 bin.test.js 只测 component symlink，与命令路由无关，需新增）。
- [ ] 回归：`activateFreshSplitInstructions` legacy 拒绝门、refresh 路径、P1 全部现有测试不动且全绿（Jest + Node）。

## Assumptions

- [ ] 语料库以**导出脚本运行结果为准**（方法：rev-list 全可达 + 双 path + blob 去重），不在计划中断言个数（tag-only 4/5 已被 P1 plan L73 否决为不充分；path-filtered log 有 history-simplification 漏计风险，本次已实测踩到）。catalog 声明为不完备。
- [ ] managed 块形态是有限集（migration marker / onboarding 块 / portability 补丁）——以 jinglever 机 Q2 考古为据；新形态落入 C 类兜底，不会误拆。
- [ ] legacy 机不存在任何 seed provenance ledger → 自动 B 集合为空是**预期结果**，不是缺陷；工具与文档按此表述。
- [ ] 存量机在 P1 升级后均已物化 system files（本机已验）；未物化者可由本工具从包内补齐，无需网络。
- [ ] `settings.json` SessionStart 组内 3 条 assembler 条目可整体识别（以内容识别，不以位置识别）。

## Acceptance Checklist

- [ ] 沙箱：A / C / unknown-baseline / ledger-B 四类 fixture 全流程（dry-run → apply → 组装产物验证 → 幂等重跑含 A3 收敛）。
- [ ] 真机（luna.coco 机，预约的第一个真实 A 类样本）：dry-run 分类=A、零写入；`--apply` 后 CLAUDE.md=split 组装、备份可 diff 还原、marker 完整、A3 归一生效；下一会话生效链路正常（改 ZYLOS.md → /clear 生效）。
- [ ] C 类真实演练：构造样本走 agent 辅助 `--user-content` 全流程（含一次守恒拒绝 → 修正 → 通过）。
- [ ] 无回归：P1 全部测试 + 全量 Jest/Node 绿；`git diff --check` 干净。
- [ ] step7 提示文案更新可见。
