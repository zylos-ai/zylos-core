# Dev Plan: #722 P2 — 存量机迁移工具（migrate-instructions）+ A3 hook 位置归一

> R1（task comment `f971e195`）4 阻塞 + R2（task comment `239dedec`）3 阻塞 + R3（task comment `4ca1f835`）3 阻塞 + R4（task comment `b1a32ae5`）4 阻塞全部采纳：
> R1 = ①catalog 范围、②B 类判定、③守恒/丢弃矛盾、④A3 收敛（+4 项验证边界）；
> R2 = ⑤dry-run 与 A3 收敛的写入门限、⑥A3 异常拓扑状态机、⑦recovery residue 两阶段语义；
> R3 = ⑧CLI partial-success 结果矩阵、⑨按异常类别的真实 remediation、⑩key-based 确定性判据；
> R4 = ⑪remediation 入口可达性（already-latest 不跑 step9 → 改为工具委托调用 owner 脚本）、⑫drift 收窄为 command/timeout 投影、⑬committed-cleanup-residue 入矩阵 + active `--apply` 先跑 recovery、⑭A3 settings 原子写入协议（+L104 旧拓扑假设修正）。

## Summary

为 #722 拆层机制补上第二个（也是最后一个）marker 写入者：一个把存量机的纠缠体 `~/zylos/ZYLOS.md`（系统内容 + 用户增量混写）拆分为「纯用户 ZYLOS.md + split 组装」的 CLI 迁移工具。P1（PR #723）已让存量机保守物化 + PENDING MIGRATION 提示；P2 让存量机真正激活。顺带完成 A3：assembler SessionStart hook 位置归一到组首。

## Scope

**In：**
- 新 CLI 命令 `zylos migrate-instructions`（`cli/commands/` 新文件），默认 **dry-run**，`--apply` 才落盘。
- 分类流水线（step-0 baseline 探测 → A/C 分类（自动 B 预期为空集，见 Design 2）→ 拆分 → 逐行守恒检查 → 持久备份 → 事务激活 → seed 元数据）。
- 历史模板语料库随包内置（**全部可达历史 blob**，非 tag-only，见 Design 1）+ 已知 managed 块识别器。
- `instruction-builder.js` 新增迁移激活入口（复用 `commitEntries` 事务，marker 最后原子落盘）。
- A3：激活时归一 assembler hook 位置；已激活机重跑必须检测 A3（裸跑只报告，`--apply` 收敛，见 Design 6）。
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
5. **事务、marker 与故障语义（R1-④ + R2-⑦ 修订）**：所有 instruction 写入走 `commitEntries` 单事务（提交点 = marker rename，`instruction-builder.js:210`），marker 追加 `migration: {classification, matchedTemplate:{sha256, source}, originalSha256, backupPath, migratedAt}`。**Recovery residue 两阶段语义（对齐现行 commitEntries 合同）**：故障返回**当下**允许且必须保留可判别的恢复记录（rollback 自身失败保留 `.split-txn.*` 记录、cleanup 失败保留 committed `.bak`，交由下次重试恢复/清理——现有测试 instruction-split.test.js:209-267 的既定合同，实现者**不得**为“失败即无残留”而删除这些记录）；「原文件逐字节保留或完整提交 + 无残留」是**成功重试后的终态断言**，不是失败当下的断言。
6. **A3 归一：写入门限与异常拓扑状态机（R2-⑤⑥ 修订）**：
   - **写入门限**：无 `--apply` 时（含已激活机上的裸重跑）A3 **永远只报告 drift、零写入**（settings.json / .backup 均逐字节不动，事务 residue 只报告存在、不执行 recovery）；**只有 active + `--apply`** 才执行收敛。已激活机 `--apply` 重跑 = A3 收敛（幂等）→ 报告 already-active → 退出 0；marker 提交后 settings 失败/被杀 → 下次 `--apply` 重跑必然修复，修复后再跑零 diff。
   - **recovery 前置门（R4-⑬）**：**所有 `--apply` 路径（含 active 机的 already-active 短路之前）必须先执行 `recoverSplitTransaction`**——committed cleanup residue（`commitEntries` 吞掉 cleanup error 的既定行为，`instruction-builder.js:238-248`、`instruction-split.test.js:239-253`）由此保证在任何 `--apply` 重跑时被清扫；dry-run 只报告 residue 存在与含义。
   - **A3 settings 原子写入协议（R4-⑭）**：P2 自有的 A3 归一写入走 temp + fsync + rename 原子提交（复用 `atomicWrite` 模式）：rename 前被杀 = 原文件逐字节不动，rename 后被杀 = 新内容完整——无部分写状态，A2 的「settings 零改动或完整生效 + 可重试」由此机制支撑，无需 restore 路径。工具读 settings 一律**严格解析**：malformed JSON → A3 refusal + 人工修复引导（绝不降级 `{}`）。（sync-settings-hooks 自身的 `writeFileSync` 非原子是 step9 既有语义，超出 P2，记 #727 追加项。）
   - **确定性判据（R3-⑩：key-based，无模糊匹配）**：hook 身份 = `hookScriptKey()`（归一化脚本路径 + shard 后缀，`hook-utils.js:180-199`，与 canonical sync 同一机制）。对 startup/clear/compact 三个 canonical matcher（P1 合同：各恰好一次，`sync-settings-hooks.js:127-131` 生成器即如此），按「组内 assembler-key 条目计数 + 对象比对」分类；**不同 key 的条目一律 = foreign**（含不同路径同 basename 的“形似”条目），原样保留、不计数、不构成异常。原「lookalike」类别溶解为：同 key 但对象非 exact-canonical = **drift**；不同 key = **foreign**。
   - **状态 → 动作 → remediation（R3-⑨ + R4-⑪⑫ 修订：可修类由工具在 `--apply` 内委托 owner 脚本执行，入口必达）**：
     | 状态（每组判定） | dry-run 输出 | `--apply` 动作 | 仍未收敛时的 remediation |
     |---|---|---|---|
     | canonical：三组各恰一条 assembler-key 条目且对象 exact-canonical | 报告拟归一 | 归一 = 移到本组首位，其余条目相对次序不变；幂等，再跑零 diff | — |
     | missing：某组无 assembler-key 条目（或组缺失） | 报告 + 「`--apply` 将委托 hook-sync 补齐」 | **委托调用已安装包的 `cli/lib/sync-settings-hooks.js`**（与 step9 同一 shell-out 方式，`self-upgrade.js:1001-1006` 的解析路径）→ 严格重读 settings → 重新分类 → canonical 则继续归一 | 委托后仍非 canonical → refusal + 人工修复定位 |
     | drift（**R4-⑫ 收窄**）：同 key 恰一条，且与 canonical 的差异**仅限 command/timeout 字段投影** | 同上 | 同上（hook-sync 仅更新 command/timeout，`sync-settings-hooks.js:463-467` 已实证——投影外差异它不修，故不归入 drift） | 同上 |
     | same-key-manual（R4-⑫ 新增）：同 key 恰一条，但差异超出 command/timeout 投影（多字段如 `async:true`、缺字段、type 异常） | 报告 + 人工修复定位 | loud refusal，settings 零改动（hook-sync added=0/updated=0/removed=0 已实证，不得引导白跑） | 人工修复（打印 event/matcher/字段 diff） |
     | duplicate-entry：某组内 assembler-key 条目 ≥2 | 同上 | loud refusal，settings 零改动（hook-sync 不去重：forward 首匹配 / reverse 保留 template-key，L441-470/L493-538 已实证） | 人工删除多余条目（打印 event/matcher/序号） |
     | duplicate-group：同 matcher 值出现于 ≥2 组 | 同上 | loud refusal，settings 零改动 | 人工合并/删除多余组 |
   - **入口可达性（R4-⑪ 事实修正）**：`zylos upgrade --self` 在 already-latest 时于 `component.js:1048-1056` 早退、**不会**执行 step9——原「引导用户跑 upgrade」的 remediation 不可达，已废弃。改为工具在 `--apply` 内直接委托调用 owner 脚本：不新增公开命令面，不自行改 hook（所有 hook 写入仍由 canonical sync 代码执行），reachability 由「工具与脚本同包」保证。委托调用的作用域 = 完整 canonical hook reconciliation（与每次升级 step9 相同的既有全局行为），其自身的非原子写入是 step9 既有语义，不在 P2 修（可作为 #727 追加项记录）；委托后工具**严格解析** settings 重验（解析失败 → refusal，绝不降级为 `{}`）。
   - **所有权事实**：hook 写入所有权不变（canonical sync 代码）；工具仅编排调用 + 位置归一。duplicate/same-key-manual 类当前没有自动 owner——若要 dedupe/全字段归一能力，另立带 owner/scope/tests 的独立 issue，不在 P2。
   - 迁移本体（instruction 事务）的成败**不受 A3 影响**——激活已提交则按结果矩阵以 partial-success 结束，重跑持续重报，不静默跳过。
   - **保护合同**：所有 foreign（非 assembler-key）hook 条目在任何路径下深度相等 + 顺序不变。
7. **CLI 结果矩阵（R3-⑧：partial-success contract 定案）**。exit code 约定：**0 = 完全成功 / 1 = 请求的动作未执行（fatal 或 refusal）/ 2 = partial success（迁移已提交但 A3 pending）**——2 的先例：`zylos runtime` 以 exit 2 表「可行动的非致命状态」。调用方语义：exit 1 → 本次零迁移（或故障 residue 可重试恢复）；exit 2 → 激活已完成，按 stderr 的 remediation 处理后重跑 `--apply` 收敛 A3。
   | # | 前置状态 + flags | instruction 事务/marker | settings | stdout | stderr | exit |
   |---|---|---|---|---|---|---|
   | D1 | dry-run（含 active 裸重跑），分析成功 | 不动 | 不动 | 完整报告（分类/A3 状态/拟动作/remediation） | — | 0 |
   | D2 | dry-run，fatal（pre-v0.4 无 ZYLOS.md / 文件不可读 / 状态损坏） | 不动 | 不动 | — | 错误 + 引导 | 1 |
   | A1 | `--apply`，A 类（或 `--user-content` 守恒通过），事务提交，A3 canonical → 已归一 | 提交，marker 含 migration 元数据 | 已写（归一） | 成功报告 + backupPath | — | 0 |
   | A1w | `--apply`，事务提交成功但 cleanup 失败（R4-⑬：committed `.split-txn.*.bak` residue，功能完整） | 已提交 + residue 保留 | 已写（归一） | 成功报告 + residue 提示「下次 `--apply` 自动清扫」 | — | 0 |
   | A2 | `--apply`，事务已提交，A3 异常拒绝（same-key-manual/duplicate 类，或委托 sync 后仍非 canonical）**或** A3 原子写 rename 前失败/被杀 | 已提交 | 零改动（原子协议保证） | 迁移成功报告 + backupPath | A3-pending + 按类别 remediation | 2 |
   | A3r | active + `--apply`，canonical 位置漂移 → 收敛 | 已 active，不动 | 已写 | already-active + 已收敛 | — | 0 |
   | A4 | active + `--apply`，A3 异常 → 拒绝 | 不动 | 零改动 | already-active | A3-pending + remediation | 2 |
   | R1 | `--apply`，C 类且无 `--user-content` | 不动，无 marker | 不动 | 分析报告（候选 + 残差） | 拒绝理由 + `--user-content` 流程引导 | 1 |
   | R2 | `--apply` + `--user-content` 守恒不通过 | 不动，无 marker | 不动 | 归因表 | 违规行清单 | 1 |
   | F | `--apply` fatal（备份 copy 失败 → 零 mutation；事务中途故障 → 按 Design 5 两阶段 residue） | 按 residue 语义 | 零改动 | — | 错误 + 重试引导 | 1 |
   报告文件（`migration-report.md`）仅在发生 live mutation 的路径（A1/A1w/A2）写入备份目录；D/R/F 路径零写入，报告只走 stdout/stderr。active `--apply` 行（A3r/A4）在 already-active 短路前先执行 recovery 前置门（Design 5），清扫到 residue 时 stdout 注明。
8. **前置状态要求**：机器须已有 P1 物化（无则先 `deployInstructionAssets` 从包内补齐）；pre-v0.4 机（无 ZYLOS.md）→ 明确报错（矩阵行 D2/F 的具体案例），引导按其 CLI 状态走可达路径：有新版可升 → `zylos upgrade --self`（step7 runMigrations 生成 ZYLOS.md）；CLI 已最新 → `zylos init` re-init 迁移路径（同样调用 runMigrations，`init.js:2322`）——与 R4-⑪ 同理，不给出 already-latest 下不可达的指引。

## Development Checklist

- [ ] 语料库导出脚本（`git rev-list --all` 全可达枚举、双 path、blob 去重、manifest 含 sha256+来源）+ 语料库静态文件入包；脚本可重跑、幂等。
- [ ] managed 块识别器（migration marker / onboarding 块 / portability 补丁），含截断/嵌套/lookalike 负例的防误吞处理。
- [ ] 分类器 `classifyInstructionBaseline()`：输出 {classification: A|C（+ ledger 命中时 B）, matched|candidates, managedBlocks, residual}；纯函数、路径显式传入；自动 B 仅走 provenance ledger 分支。
- [ ] 守恒检查器：occurrence/edit-script 保序计数归因；无丢弃分支；CRLF/末行/marker 边界处理。
- [ ] 备份模块：`.backup/<ts>/instruction-migration/` 布局、先备份后改动、copy 校验、任一失败零 mutation、报告落盘。
- [ ] `instruction-builder.js` 新增 `activateMigratedSplitInstructions({userContent, migrationMeta, ...})`：单事务写入（含新用户 ZYLOS.md）→ marker（P1 字段 + migration 元数据）。不触碰 `activateFreshSplitInstructions` 的 legacy 拒绝门。
- [ ] CLI 命令 `zylos migrate-instructions`：dry-run 默认（零写入，A3 只报 drift）；`--apply`；`--user-content <file>`；已激活机 `--apply` 重跑 = A3 收敛 + already-active 退出 0，裸重跑 = 只报告。
- [ ] A3 归一实现（Design 6 状态机：canonical 判定 / 归一 / 异常态 loud refusal；激活后执行与 active-rerun 收敛共用同一幂等函数）。
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
- [ ] **事务故障矩阵（逐 entry 精确列举，不笼统写「复用 P1」）**：user ZYLOS / claude-system / codex-system / onboarding / assembler / claude-output / codex-output / marker 八项，覆盖 stage 后 kill、rename 中 kill（old→txn-backup 后、new→live 后）、rollback remove/restore 失败、commit 后 cleanup 失败。**两阶段断言（R2-⑦）**：fault 当下断言可判别 recovery residue / marker 状态被保留（不得被清）；成功重试后断言终态二态收敛（原文件逐字节保留或完整提交、无残留）。
- [ ] **A3 写入门限与故障收敛（R2-⑤ + R4-⑭）**：active + A3-drift 状态下裸重跑 → 报告 drift 且 settings/.backup 逐字节零写入；同状态 `--apply` → 收敛 → 再跑零 diff；A3 原子写 rename **前**被杀 → settings 逐字节原样 → `--apply` 重跑修复 → 再跑零 diff；rename **后**被杀 → 新内容完整无部分写；settings malformed JSON → A3 refusal + 人工引导（断言不降级 `{}`、不写入）。
- [ ] **remediation 入口可达性（R4-⑪）**：already-latest 机 + missing/drift 拓扑 → `--apply` 内委托 sync 真实补齐/更新 settings → 同次运行重验为 canonical → 归一 → exit 0（断言全链无需第二条用户命令）；委托后仍非 canonical（构造 same-key-manual）→ refusal + exit 2。
- [ ] **drift 投影边界（R4-⑫）**：同 key 仅 command 漂移 / 仅 timeout 漂移 → 判 drift 且委托后收敛；同 key 加 `async:true`（投影外多字段）→ 判 same-key-manual、委托不执行或执行后断言 added=0/updated=0/removed=0、refusal + 字段 diff 输出。
- [ ] **committed cleanup residue（R4-⑬）**：注入 cleanup 失败 → 断言 commit 成功 + marker 完整 + `.bak` residue 保留 + exit 0 + stdout residue 提示（矩阵 A1w）；随后 active `--apply` 重跑 → recovery 前置门清扫 residue → 零残留 + A3 幂等；active 裸重跑 → 仅报告 residue、零写入。
- [ ] **A3 异常拓扑（R2-⑥ + R3-⑨⑩，每例断言精确后置条件 + remediation 文案）**：duplicate-entry（同组两条 assembler-key）→ refusal + settings 逐字节不动 + stderr 含人工修复定位（不得引导 hook-sync）；missing（组内无 assembler-key / 组缺失）→ refusal + stderr 引导 hook-sync；drift（同 key 对象漂移）→ refusal + stderr 引导 hook-sync；duplicate-group（同 matcher 两组）→ refusal + 人工修复引导；foreign 同 basename 不同路径（key 不同）→ 判 foreign、不计数、不移动、不出现在异常报告；canonical 态 → 归一后所有 foreign hook 深度相等 + 顺序不变，重跑零 diff。
- [ ] **CLI 结果矩阵全行覆盖（R3-⑧ + R4-⑬）**：真入口子进程逐行验证 Design 7 矩阵 D1/D2/A1/A1w/A2/A3r/A4/R1/R2/F 的 stdout 内容、stderr 内容、exit code、事务/marker/settings 后置状态；exit 2 行额外验证「remediation 后重跑 `--apply` → exit 0 收敛」链。
- [ ] **CLI 真入口**：子进程执行 `cli/zylos.js migrate-instructions` 的 dispatch、flags 解析（未知 flag 拒绝）；结果矩阵行的详细断言见上条（现 bin.test.js 只测 component symlink，与命令路由无关，需新增）。
- [ ] 回归：`activateFreshSplitInstructions` legacy 拒绝门、refresh 路径、P1 全部现有测试不动且全绿（Jest + Node）。

## Assumptions

- [ ] 语料库以**导出脚本运行结果为准**（方法：rev-list 全可达 + 双 path + blob 去重），不在计划中断言个数（tag-only 4/5 已被 P1 plan L73 否决为不充分；path-filtered log 有 history-simplification 漏计风险，本次已实测踩到）。catalog 声明为不完备。
- [ ] managed 块形态是有限集（migration marker / onboarding 块 / portability 补丁）——以 jinglever 机 Q2 考古为据；新形态落入 C 类兜底，不会误拆。
- [ ] legacy 机不存在任何 seed provenance ledger → 自动 B 集合为空是**预期结果**，不是缺陷；工具与文档按此表述。
- [ ] 存量机在 P1 升级后均已物化 system files（本机已验）；未物化者可由本工具从包内补齐，无需网络。
- [ ] `settings.json` 中 assembler 条目的**唯一 oracle = Design 6 状态机**：以 `hookScriptKey` 识别身份（startup/clear/compact 三个 canonical matcher 组、canonical 态每组恰一条 exact-canonical 条目），不以位置、不以条数、不以模糊内容匹配识别。

## Acceptance Checklist

- [ ] 沙箱：A / C / unknown-baseline / ledger-B 四类 fixture 全流程（dry-run → apply → 组装产物验证 → 幂等重跑：裸跑零写入只报告、`--apply` 含 A3 收敛）。
- [ ] 真机（luna.coco 机，预约的第一个真实 A 类样本）：dry-run 分类=A、零写入；`--apply` 后 CLAUDE.md=split 组装、备份可 diff 还原、marker 完整、A3 归一生效；下一会话生效链路正常（改 ZYLOS.md → /clear 生效）。
- [ ] C 类真实演练：构造样本走 agent 辅助 `--user-content` 全流程（含一次守恒拒绝 → 修正 → 通过）。
- [ ] 无回归：P1 全部测试 + 全量 Jest/Node 绿；`git diff --check` 干净。
- [ ] step7 提示文案更新可见。
