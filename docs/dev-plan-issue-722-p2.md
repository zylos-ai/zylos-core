# Dev Plan: #722 P2 — 存量机迁移工具（migrate-instructions）+ A3 hook 位置归一

> R1（task comment `f971e195`）4 阻塞 + R2（task comment `239dedec`）3 阻塞 + R3（task comment `4ca1f835`）3 阻塞 + R4（task comment `b1a32ae5`）4 阻塞全部采纳：
> R1 = ①catalog 范围、②B 类判定、③守恒/丢弃矛盾、④A3 收敛（+4 项验证边界）；
> R2 = ⑤dry-run 与 A3 收敛的写入门限、⑥A3 异常拓扑状态机、⑦recovery residue 两阶段语义；
> R3 = ⑧CLI partial-success 结果矩阵、⑨按异常类别的真实 remediation、⑩key-based 确定性判据；
> R4 = ⑪remediation 入口可达性（already-latest 不跑 step9 → 改为工具委托调用 owner 脚本）、⑫drift 收窄为 command/timeout 投影、⑬committed-cleanup-residue 入矩阵 + active `--apply` 先跑 recovery、⑭A3 settings 原子写入协议（+L104 旧拓扑假设修正）；
> R5（task comment `67dcef3b`）3 阻塞 = R5-①整脚本委托收窄为 owner 模块窄 typed seam、R5-②manual-first 全局 preflight + 单次原子写、R5-③crash/SIGKILL 与 handled error 分离（+L102 旧引导修正）；
> R6（task comment `b9e0af64`）3 阻塞 = R6-①canonical policy 所有权闭合（seam 不再由调用方传 canonicalEntries；「canonical 来自 template settings」系事实错误——template settings 无任何 hooks，真实来源为 owner generator 按 zylosDir 动态构造）、R6-②schema-malformed topology 结构 preflight（防止合法 JSON 异常形态被降级为 missing 后覆盖丢数据）、R6-③cleanup residue × A3 refusal/error 组合行 A2w + 优先级规则；
> R7（task comment `369fd03d`）2 阻塞 = R7-①结构 preflight 闭合到 settings 根/`hooks` 父容器 + matcher absent≡`''` 对齐 owner 归一语义 + wrong-type assembler 唯一分类（same-key-manual，不判 foreign）、R7-②矩阵 F 拆分 F1/F2（备份完成前零 live mutation vs 备份校验后故障必须保留 durable backup + failure report）；
> R8（DM 撤回 CLEAN 后补充）1 阻塞 = R8-①key 分类改为**全局扫描所有 SessionStart groups**：assembler-key 出现在非 canonical matcher 组（''/absent catch-all 或任意其他 matcher）= 新类 misplaced → preflight 整体 refusal（owner reverse pass 对该形态为清除语义，保留即双重执行；删除无自动 owner，工具不代行）；
> R9（task comment `78822421`）2 阻塞 = R9-①drift 双重定义闭合（L49 旧宽定义改 projection-aware：same-key 仅 command/timeout 差异 = drift，任一投影外差异 = same-key-manual；三格互斥穷尽的表驱动断言）、R9-②duplicate-group 收窄到 canonical matcher + 成功门容纳合法 foreign-only 非 canonical 组（owner 不合并重名纯 foreign 组，工具无权迫使用户改 foreign topology）；
> R10（task comment `dba96334`）2 阻塞 = 矩阵行与 R9 成功门同步：R10-①A3r 前置从「全组 ∈ {canonical,missing,drift}」改为 Design 6 成功门（canonical 三组 + 其余 foreign-only 保留）、R10-②A1/A1w 覆盖完整成功门（fresh migration + 同次 missing/drift seam 收敛 + foreign-only 保留），补 fresh 成功门真入口 fixture。

## Summary

为 #722 拆层机制补上第二个（也是最后一个）marker 写入者：一个把存量机的纠缠体 `~/zylos/ZYLOS.md`（系统内容 + 用户增量混写）拆分为「纯用户 ZYLOS.md + split 组装」的 CLI 迁移工具。P1（PR #723）已让存量机保守物化 + PENDING MIGRATION 提示；P2 让存量机真正激活。顺带完成 A3：assembler SessionStart hook 位置归一到组首。

## Scope

**In：**
- 新 CLI 命令 `zylos migrate-instructions`（`cli/commands/` 新文件），默认 **dry-run**，`--apply` 才落盘。
- 分类流水线（step-0 baseline 探测 → A/C 分类（自动 B 预期为空集，见 Design 2）→ 拆分 → 逐行守恒检查 → 持久备份 → 事务激活 → seed 元数据）。
- 历史模板语料库随包内置（**全部可达历史 blob**，非 tag-only，见 Design 1）+ 已知 managed 块识别器。
- `instruction-builder.js` 新增迁移激活入口（复用 `commitEntries` 事务，marker 最后原子落盘）。
- A3：激活时归一 assembler hook 位置；已激活机重跑必须检测 A3（裸跑只报告，`--apply` 收敛，见 Design 6）。
- **指令架构版本标记**：`--apply` 成功后写 `.zylos/instruction-format-version`（内容 = `2`，代表分层拼接架构）。用于后续 upgrade 流程快速判定是否需要迁移（P3 消费方）。幂等：重跑写入同值。
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
4. **持久备份契约（R1 验证边界落实；#717 是契约先例而非可复用 helper——现实现仅 `self-upgrade.js:641` 为 smart-merge conflicts 内联建 `.backup/<ts>/conflicts`）**：本工具自建布局 `~/zylos/.backup/<timestamp>/instruction-migration/`，内含原 ZYLOS.md / CLAUDE.md / AGENTS.md（存在者全备）+ `migration-report.md`（分类、归因表、候选清单）。**全部 copy 成功并校验后才允许任何 live mutation**；任一 copy 失败 → 零 live mutation 退出（矩阵 F1：partial backup 目录 best-effort 移除——其中仅为未动原件的副本；移除失败 → 警告 + 打印路径）。**备份完整校验后**的事务中途故障 = 矩阵 F2：备份目录 + failure `migration-report.md`（故障点、residue 状态、重试语义）**必须保留**（durable evidence，#717 合同；重试的 recovery 不得清理持久备份目录）（R7-② 拆分）。备份在成功/失败（F2）/重试后都保留（不自动清理，同 #717 语义）；打印路径 = marker.backupPath = 实际目录；与事务临时件 `.split-txn.*.bak` 严格分离（路径与清理器都不相交）。
5. **事务、marker 与故障语义（R1-④ + R2-⑦ 修订）**：所有 instruction 写入走 `commitEntries` 单事务（提交点 = marker rename，`instruction-builder.js:210`），marker 追加 `migration: {classification, matchedTemplate:{sha256, source}, originalSha256, backupPath, migratedAt}`。**事务提交成功后（marker 已落盘），写 `.zylos/instruction-format-version`（内容 = `2\n`，无 JSON）**——用于 P3 upgrade 流程快速判定「是否需要迁移」（读一个纯文本文件比解析 marker JSON 便宜且不耦合 marker schema）；`fresh init` 路径也写同值（activateFreshSplitInstructions 末尾追加，保证所有新架构机一致标记）。该文件写入在 marker 之后、A3 之前；写入失败不影响迁移成功判定（marker 是 source of truth），但需 stderr 警告 + remediation「重跑 `--apply` 补写」。**Recovery residue 两阶段语义（对齐现行 commitEntries 合同）**：故障返回**当下**允许且必须保留可判别的恢复记录（rollback 自身失败保留 `.split-txn.*` 记录、cleanup 失败保留 committed `.bak`，交由下次重试恢复/清理——现有测试 instruction-split.test.js:209-267 的既定合同，实现者**不得**为“失败即无残留”而删除这些记录）；「原文件逐字节保留或完整提交 + 无残留」是**成功重试后的终态断言**，不是失败当下的断言。
6. **A3 归一：写入门限与异常拓扑状态机（R2-⑤⑥ 修订）**：
   - **写入门限**：无 `--apply` 时（含已激活机上的裸重跑）A3 **永远只报告 drift、零写入**（settings.json / .backup 均逐字节不动，事务 residue 只报告存在、不执行 recovery）；**只有 active + `--apply`** 才执行收敛。已激活机 `--apply` 重跑 = A3 收敛（幂等）→ 报告 already-active → 退出 0；marker 提交后 settings 失败/被杀 → 下次 `--apply` 重跑必然修复，修复后再跑零 diff。
   - **recovery 前置门（R4-⑬）**：**所有 `--apply` 路径（含 active 机的 already-active 短路之前）必须先执行 `recoverSplitTransaction`**——committed cleanup residue（`commitEntries` 吞掉 cleanup error 的既定行为，`instruction-builder.js:238-248`、`instruction-split.test.js:239-253`）由此保证在任何 `--apply` 重跑时被清扫；dry-run 只报告 residue 存在与含义。
   - **A3 settings 原子写入协议（R4-⑭ + R5-③ 修订：handled error 与 crash 分离）**：A3 的唯一 settings 写入（seam 补齐 + 归一合成后的单次写）走 temp + fsync + rename 原子提交：rename 前被杀 = 原文件逐字节不动，rename 后被杀 = 新内容完整——**文件二态**由机制保证。**结果语义分两类**：(a) **handled error**（工具捕获的 I/O 失败，如 temp 写失败、rename EACCES）→ 可正常报告，走矩阵 A2/A4（settings 零改动 + remediation「重跑 `--apply`」）；(b) **crash/SIGKILL** → 进程无法产出任何 stdout/stderr/exit code，**不建模为矩阵行**——crash contract 只承诺：settings 处于 old-or-new 二态、instruction 事务状态由 Design 5 residue 语义覆盖、下次 `--apply` 重跑必然收敛。工具读 settings 一律**严格解析**：malformed JSON → A3 refusal + 人工修复引导（绝不降级 `{}`）。（sync-settings-hooks 脚本自身的 `writeFileSync` 非原子是 step9 既有语义——P2 改走窄 seam + 自有原子写后已不在本工具链路上，仍记 #727 追加项。）
   - **确定性判据（R3-⑩：key-based，无模糊匹配）**：hook 身份 = `hookScriptKey()`（归一化脚本路径 + shard 后缀，`hook-utils.js:180-199`，与 canonical sync 同一机制）。对 startup/clear/compact 三个 canonical matcher（P1 合同：各恰好一次，`sync-settings-hooks.js:127-131` 生成器即如此），按「组内 assembler-key 条目计数 + 对象比对」分类；**不同 key 的条目一律 = foreign**（含不同路径同 basename 的“形似”条目），原样保留、不计数、不构成异常。原「lookalike」类别溶解为（R9-① 修订，对齐 R4-⑫ 投影合同）：同 key + 差异**仅限 command/timeout 投影** = **drift**；同 key + 任一投影外差异（`async`、缺字段、type 异常等）= **same-key-manual**；不同 key = **foreign**。exact / projection-only / 投影外差异三格**互斥且穷尽**（分类器表驱动断言，见 Test Checklist）。
   - **执行顺序（R5-② + R6-② 修订：结构校验 → preflight 分类，单一状态机）**：`--apply` 的 A3 阶段 = ①严格读 settings（strict JSON parse，malformed JSON → refusal）→ ②**结构 preflight（R6-② + R7-① 修订，先于任何 key 分类；自根向下的 owner-compatible topology 闭合校验）**：settings 根必须为 JSON object（object 判据全文统一 = non-null 且非数组）；`hooks` 若 present 必须为 object（owner 写路径直接创建/赋值 `installedSettings.hooks[event]`——`sync-settings-hooks.js:427-438`——父容器形态是写前置条件，不得留给 seam 猜；`{"hooks":"legacy"}`、`{"hooks":[]}` 等合法 JSON 一律 schema-malformed，不得因 SessionStart absent 落入 missing）；`hooks.SessionStart` 若 present 必须为数组；每个 group 必须为 object；`matcher` **absent 视同 `''`（catch-all，合法 foreign 组，原样保留、不拒绝）、present 必须为字符串**——与 owner sync 归一语义一致（`sync-settings-hooks.js:442-445,501-504`）；group 的 `hooks` 若 present 必须为数组；hook 元素必须为 object。任何不满足 = **schema-malformed** → 整体 refusal、settings 逐字节零改动、输出精确 JSON 位置 + 期望类型。**分类实现不得复用 `getCommandHooks()` 的宽松归零语义**（`hook-utils.js:205-211` 把非对象 group / 非数组 `hooks` 静默映射为 `[]`——直接用于分类会把 `hooks:{legacy:"keep"}` 之类误判为 missing，写入时覆盖丢数据，违反 preflight 零改动与 foreign-preserve 合同）→ ③**全局 key 分类（R8-① 修订：扫描所有 SessionStart groups，不只 canonical 三组；全量判定后才决定动作，不逐组边判边写）**。**身份判定与 `type` 无关（R7-①）**：assembler-key 身份仅以 `command` 字段的 `hookScriptKey` 判定；same-key 条目 `type` 缺失/异常 = **same-key-manual refusal**（与 R4 command/timeout 投影合同一致——type 不在投影内），**不得**判为 foreign 后再由 seam 补第二条同 command 条目；`command` 非字符串/缺失的元素无法取 key = foreign 原样保留。**assembler-key 条目出现在非 canonical matcher 组（含 ''/absent catch-all 与任意其他 matcher 值；type 无关，按 key 捕获）= misplaced（R8-①）**——owner sync reverse pass 对无对应 template 组的 core-managed 条目是清除语义（`sync-settings-hooks.js:493-533`：correspondingTemplate 缺失 → foundInTemplate=false → 移除），工具若视而不见会「canonical 判 missing 补齐 + misplaced 保留」= 双重执行且违背 owner 语义；而删除无自动 owner（同 duplicate 处理原则），故 misplaced = refusal → ④若存在 **misplaced** / 任一组 same-key-manual / duplicate-entry / duplicate-group → **委托与写入一律不执行**，整体 refusal，settings 逐字节零改动（A2/A4 零改动承诺由此成立，混合拓扑如「startup missing + clear duplicate」也落在此格）→ ⑤否则进入**成功门（R9-② 修订）**：canonical 三组各自 ∈ {canonical, missing, drift}，**其余所有 groups 均为 foreign-only**（不含任何 assembler-key 条目）且逐字节 + 顺序原样保留——**含重名 catch-all（''/absent）或重名任意 matcher 的纯 foreign 组，均合法、允许收敛、不构成 refusal**（owner forward pass 只对 desired canonical matcher 对齐（`sync-settings-hooks.js:429-487`）；reverse pass 对其余组仅移除 unmatched core-managed/claimed 条目，different-key foreign 原样保留、不合并重名组（L489-544）——本工具无权要求用户修改与 A3 无关的 foreign topology）→ 在**内存中**合成「seam 补齐/修正 + 位置归一」后的完整 settings → ⑥**单次原子写**提交。两步合一写 = 不存在「sync 已写、归一未写」的中间态。
   - **状态 → 动作 → remediation（R3-⑨ + R4-⑫ + R5-① 修订）**：
     | 状态（每组判定） | dry-run 输出 | `--apply` 动作（在上述 preflight 通过的前提下） | remediation |
     |---|---|---|---|
     | canonical：三组各恰一条 assembler-key 条目且对象 exact-canonical | 报告拟归一 | 归一 = 移到本组首位，其余条目相对次序不变；幂等，再跑零 diff | — |
     | schema-malformed（R6-② + R7-①）：settings 根或 `hooks` 非 object（null/数组/标量）/ SessionStart 非数组 / group 非 object / matcher present 非字符串 / group `hooks` 非数组 / hook 元素非 object | 报告精确 JSON 位置 + 期望类型 | **结构 preflight 整体 refusal**（先于任何 key 分类），零改动 | 人工修复（打印 JSON path + 期望类型；不得被降级为 missing） |
     | missing：结构校验通过后，某组无 assembler-key 条目（或组缺失） | 报告 + 「`--apply` 将补齐」 | 经 **owner 模块内的窄 typed seam**（见下）在内存中补齐 → 与归一合并为单次原子写 | （seam 后置校验失败 → refusal 零改动 + 人工定位） |
     | drift（R4-⑫ 收窄）：同 key 恰一条，差异**仅限 command/timeout 投影** | 同上 | 同上（seam 仅投影内修正） | 同上 |
     | same-key-manual：同 key 恰一条，差异超出投影（如 `async:true`、缺字段、type 异常） | 报告 + 人工修复定位 | **preflight 整体 refusal**，零改动 | 人工修复（打印 event/matcher/字段 diff） |
     | duplicate-entry：某组内 assembler-key 条目 ≥2 | 同上 | 同上（hook-sync 与 seam 均不去重） | 人工删除多余条目（打印 event/matcher/序号） |
     | duplicate-group（R9-② 收窄）：**canonical matcher 值（startup/clear/compact）出现于 ≥2 组**；非 canonical matcher 的重名 foreign-only 组不构成异常（见成功门） | 同上 | 同上 | 人工合并/删除多余组 |
     | misplaced（R8-①）：assembler-key 条目位于非 canonical matcher 组（'' / absent / 任意其他 matcher；type 无关） | 同上 | 同上（**canonical 组不得同时按 missing 补齐**） | 人工移除或移入 canonical 组（打印组 matcher + 序号；owner sync 对该形态为清除语义，工具不代行删除） |
   - **窄 seam（R5-① + R6-① 修订，替代 R4 版的整脚本 shell-out）**：在 canonical sync **owner 模块** `sync-settings-hooks.js` 内新增导出的 typed 函数 `reconcileAssemblerEntries(settings, { zylosDir })`：纯内存、无 I/O，作用域**仅限三条 canonical assembler 条目**的补齐与 command/timeout 投影修正。**canonical policy 不由调用方提供（R6-①）**——template settings（`templates/.claude/settings.json`）实际不含任何 hooks，真实 canonical assembler 条目是 `desiredSessionStartHooks({zylosDir})`（`sync-settings-hooks.js:83-114`）按 zylosDir 动态构造并由 `desiredClaudeHooks()` 复制到三 matcher；因此从中抽出专用 typed builder `canonicalAssemblerEntry({ zylosDir })`（纯路径构造、无 I/O），**step9 生成器与 seam 共用同一 builder**——「canonical 是什么」及其随 owner 演进的漂移全部留在 owner 模块内；迁移工具只传 `zylosDir`，不重建、不筛选、不从任何 template 拼装 policy。前置：A3 阶段仅在 assembler 已物化后运行（激活事务本身写入 assembler；active 重跑机必然已物化）——与 owner generator 的 existsSync 门语义一致，seam 与 builder 自身保持纯函数。**明确不做**：其他 core-managed/claimed hooks、statusLine、model/boolean settings、Codex global/project config、paired threshold、`/exit` enqueue（R4 版整脚本委托的实测副作用：修 startup missing 会连带把无关 activity hook timeout 999999→5——jinglever R5 复现，废弃该方案的直接依据）。迁移工具同包 ESM import 调用，reachability 由同包保证；hook 写入语义的所有权仍在 owner 模块（seam 是 owner 模块的导出，不是迁移工具的私有实现）。
   - **所有权事实**：duplicate/same-key-manual/misplaced 类当前没有自动 owner（misplaced 在 owner sync reverse pass 内是清除语义，但该路径对 already-latest 机不可达且属整脚本作用域，见 R4-⑪/R5-①）——若要 dedupe/移位/全字段归一能力，另立带 owner/scope/tests 的独立 issue，不在 P2。
   - 迁移本体（instruction 事务）的成败**不受 A3 影响**——激活已提交则按结果矩阵以 partial-success 结束，重跑持续重报，不静默跳过。
   - **保护合同**：所有 foreign（非 assembler-key）hook 条目在任何路径下深度相等 + 顺序不变；foreign-only 组（含重名 catch-all / 任意 matcher）整组保留——不合并、不重排、不删除、不构成 refusal（R9-②）。
7. **CLI 结果矩阵（R3-⑧：partial-success contract 定案）**。exit code 约定：**0 = 完全成功 / 1 = 请求的动作未执行（fatal 或 refusal）/ 2 = partial success（迁移已提交但 A3 pending）**——2 的先例：`zylos runtime` 以 exit 2 表「可行动的非致命状态」。调用方语义：exit 1 → 本次零迁移（或故障 residue 可重试恢复）；exit 2 → 激活已完成，按 stderr 的 remediation 处理后重跑 `--apply` 收敛 A3。
   | # | 前置状态 + flags | instruction 事务/marker | settings | stdout | stderr | exit |
   |---|---|---|---|---|---|---|
   | D1 | dry-run（含 active 裸重跑），分析成功 | 不动 | 不动 | 完整报告（分类/A3 状态/拟动作/remediation） | — | 0 |
   | D2 | dry-run，fatal（pre-v0.4 无 ZYLOS.md / 文件不可读 / 状态损坏） | 不动 | 不动 | — | 错误 + 引导 | 1 |
   | A1 | `--apply`，A 类（或 `--user-content` 守恒通过），事务提交，**A3 成功门通过（R10-②）：canonical 三组各自 ∈ {canonical, missing, drift} → seam 补齐/修正 + 归一；其余组 foreign-only 原样保留** | 提交，marker 含 migration 元数据 | 已写（归一，单次原子提交） | 成功报告 + backupPath | — | 0 |
   | A1w | `--apply`，事务提交成功但 cleanup 失败（R4-⑬：committed `.split-txn.*.bak` residue，功能完整；**A3 按 A1 同一成功门收敛**） | 已提交 + residue 保留 | 已写（归一） | 成功报告 + residue 提示「下次 `--apply` 自动清扫」 | — | 0 |
   | A2 | `--apply`，事务已提交，A3 preflight refusal（schema-malformed / misplaced 或任一组 same-key-manual/duplicate 类，含混合拓扑）**或** A3 原子写 handled I/O error | 已提交 | 零改动（结构校验与 preflight 先于一切写入；原子协议保证 error 路径无部分写） | 迁移成功报告 + backupPath | A3-pending + 按类别 remediation（error 路径 = 「重跑 `--apply`」） | 2 |
   | A2w | `--apply`，事务提交成功**且** cleanup 失败（residue 保留）**且** 同次 A3 refusal / handled I/O error（R6-③ 组合行：`commitEntries` 吞掉 cleanup error 后正常返回（`instruction-builder.js:238-248`），A3 独立执行，两故障可同次发生） | 已提交 + residue 保留 | 零改动 | 迁移成功报告 + backupPath + residue 提示「下次 `--apply` 自动清扫」 | A3-pending + 按类别 remediation | 2 |
   | A3r | active + `--apply`，**Design 6 成功门（R10-①）：canonical 三组各自 ∈ {canonical, missing, drift}、其余组 foreign-only 且逐字节/顺序保留** → seam 补齐/修正 + 归一，单次原子写 | 已 active，不动 | 已写（单次原子提交） | already-active + 已收敛 | — | 0 |
   | A4 | active + `--apply`，A3 preflight refusal（同 A2 定义，含 schema-malformed）或 handled I/O error | 不动 | 零改动 | already-active | A3-pending + remediation | 2 |
   **组合优先级（R6-③）**：exit code 由 A3 结果决定——存在 A3 refusal / handled error 时一律 exit 2（A1w 的 exit 0 仅适用于「residue 存在但 A3 成功收敛」）；residue 的存在必须在 stdout 显式报告，不因 A3 失败而省略。收敛链：下次 `--apply` 先经 recovery 前置门清扫 residue，待人工拓扑修复 / handled error 消失后收敛至 exit 0（A2w → A3r/A1 路径）。
   | （X） | crash/SIGKILL（任意 `--apply` 阶段）——**非矩阵行，无 CLI 输出合同** | 按 Design 5 residue 语义 | old-or-new 二态（原子协议） | 无保证 | 无保证 | 无（signal） |
   | R1 | `--apply`，C 类且无 `--user-content` | 不动，无 marker | 不动 | 分析报告（候选 + 残差） | 拒绝理由 + `--user-content` 流程引导 | 1 |
   | R2 | `--apply` + `--user-content` 守恒不通过 | 不动，无 marker | 不动 | 归因表 | 违规行清单 | 1 |
   | F1 | `--apply` fatal，**备份完成前**（copy/校验失败，含 pre-v0.4 等前置 fatal 的 apply 形态） | 不动，无 marker | 零改动 | — | 错误 + 重试引导（partial backup 已移除；移除失败附警告+路径） | 1 |
   | F2 | `--apply` fatal，**备份完整校验后**事务中途故障（R7-②） | 按 Design 5 两阶段 residue | 零改动 | — | 错误 + **backupPath** + 重试语义（重跑 recovery 不清理持久备份；failure report 在备份目录） | 1 |
   报告文件（`migration-report.md`）在发生 live mutation 的路径（A1/A1w/A2/A2w）与 **F2**（failure report：故障点、residue、重试语义）写入备份目录；D/R/F1 路径零写入，报告只走 stdout/stderr。R7-② 澄清：「零写入/零改动」始终指 **live instruction/settings 文件**；F2 已落盘的持久备份与 failure report 是 durable evidence，任何失败路径都不得清除。active `--apply` 行（A3r/A4）在 already-active 短路前先执行 recovery 前置门（Design 5），清扫到 residue 时 stdout 注明。
8. **前置状态要求**：机器须已有 P1 物化（无则先 `deployInstructionAssets` 从包内补齐）；pre-v0.4 机（无 ZYLOS.md）→ 明确报错（矩阵行 D2/F1 的具体案例），引导按其 CLI 状态走可达路径：有新版可升 → `zylos upgrade --self`（step7 runMigrations 生成 ZYLOS.md）；CLI 已最新 → `zylos init` re-init 迁移路径（同样调用 runMigrations，`init.js:2322`）——与 R4-⑪ 同理，不给出 already-latest 下不可达的指引。

## Development Checklist

- [ ] 语料库导出脚本（`git rev-list --all` 全可达枚举、双 path、blob 去重、manifest 含 sha256+来源）+ 语料库静态文件入包；脚本可重跑、幂等。
- [ ] managed 块识别器（migration marker / onboarding 块 / portability 补丁），含截断/嵌套/lookalike 负例的防误吞处理。
- [ ] 分类器 `classifyInstructionBaseline()`：输出 {classification: A|C（+ ledger 命中时 B）, matched|candidates, managedBlocks, residual}；纯函数、路径显式传入；自动 B 仅走 provenance ledger 分支。
- [ ] 守恒检查器：occurrence/edit-script 保序计数归因；无丢弃分支；CRLF/末行/marker 边界处理。
- [ ] 备份模块：`.backup/<ts>/instruction-migration/` 布局、先备份后改动、copy 校验、任一失败零 mutation、报告落盘。
- [ ] `instruction-builder.js` 新增 `activateMigratedSplitInstructions({userContent, migrationMeta, ...})`：单事务写入（含新用户 ZYLOS.md）→ marker（P1 字段 + migration 元数据）。不触碰 `activateFreshSplitInstructions` 的 legacy 拒绝门。
- [ ] CLI 命令 `zylos migrate-instructions`：dry-run 默认（零写入，A3 只报 drift）；`--apply`；`--user-content <file>`；已激活机 `--apply` 重跑 = A3 收敛 + already-active 退出 0，裸重跑 = 只报告。
- [ ] **owner 模块窄 seam（R5-① + R6-①）**：`sync-settings-hooks.js` 新增导出 `canonicalAssemblerEntry({ zylosDir })`（从 `desiredSessionStartHooks` 抽出，step9 生成器改为复用同一 builder）+ `reconcileAssemblerEntries(settings, { zylosDir })`——纯内存、无 I/O、仅 assembler 三条目补齐 + command/timeout 投影修正，canonical policy 全部在 owner 模块内派生（调用方零 policy 输入）；单测含 blast-radius 负例（statusLine/model/Codex config/其他 hook——含 jinglever 复现的 activity timeout 999999——逐字节不动）+ **非默认 zylosDir 动态路径一致性**（seam 补齐产物与 `desiredSessionStartHooks({zylosDir})` 的 assembler 条目逐字段一致，startup/clear/compact 三组各一次）+ step9 回归（重构后 `desiredClaudeHooks` 输出与重构前逐字节一致）。
- [ ] A3 归一实现（Design 6 状态机：严格读 → 结构 preflight（R6-②，不复用 `getCommandHooks` 宽松语义）→ 全组 key 分类 → 整体 refusal 或 内存合成 seam+归一 → 单次原子写；激活后执行与 active-rerun 收敛共用同一幂等函数）。
- [ ] **指令架构版本标记**：`--apply` 成功后写 `.zylos/instruction-format-version`（`2\n`）；`activateFreshSplitInstructions` 末尾同步追加；写入失败 stderr 警告 + remediation 但不影响 exit code（marker 已提交）。
- [ ] step7 PENDING MIGRATION 提示文案指名新命令。

## Test Checklist

- [ ] fixture：A 类（catalog blob 逐字节，含一个**非 tag、仅 branch 历史可达**的 blob 样本）/ C 类（无法归因混改）/ pre-v0.4 家族样本（旧 CLAUDE 模板 + migration marker + onboarding 块，jinglever 机形态）→ 剥离 managed 块后正确分类。
- [ ] **unknown-baseline 负面 fixture（P1 plan L55 恢复）**：「不可达真实模板 = candidate + X，当前文件 = 真实模板 + 用户 Y」→ 必须判 C，X 不得被归为用户内容，catalog 内唯一 pure-add **不得**自动升 B。
- [ ] provenance-ledger B 类正例（构造 recorded seed hash 命中）→ 自动拆分成立；同样本去掉 ledger → 判 C。
- [ ] 守恒负面：注入无法归因行 → 拒绝；omitted / duplicated / reordered identical lines（membership 并集会漏检的三类）→ 拒绝；CRLF、无末行换行、managed marker 截断/嵌套/lookalike → 不误吞不误放行。
- [ ] `--user-content` 缺行（原始非 managed 内容未落入用户文件）→ 拒绝，无丢弃出口。
- [ ] dry-run 零写入：跑前后全目录（含 settings.json、.backup）hash 清单逐字节一致。
- [ ] `--apply` A 类：备份先落且逐字节可还原；新 CLAUDE.md/AGENTS.md = split 头 + system + 用户内容；marker migration 元数据完整；守恒归因表落报告。
- [ ] 备份失败注入（copy 中途失败，矩阵 F1）→ 零 live mutation、partial backup 目录已移除（或移除失败时警告+路径）、明确报错、可重试。
- [ ] **F2 durable-backup oracle（R7-②）**：真入口 fixture——备份全部 copy+校验成功 → 注入事务中途故障 → 断言 live 侧按 Design 5 residue 语义 + 备份目录三原件与 failure `migration-report.md` 完整可审计 + stderr 含 backupPath 与重试语义 + exit 1；重跑 `--apply` → 收敛，且持久备份目录未被 recovery 清理、可 diff 还原。
- [ ] **事务故障矩阵（逐 entry 精确列举，不笼统写「复用 P1」）**：user ZYLOS / claude-system / codex-system / onboarding / assembler / claude-output / codex-output / marker 八项，覆盖 stage 后 kill、rename 中 kill（old→txn-backup 后、new→live 后）、rollback remove/restore 失败、commit 后 cleanup 失败。**两阶段断言（R2-⑦）**：fault 当下断言可判别 recovery residue / marker 状态被保留（不得被清）；成功重试后断言终态二态收敛（原文件逐字节保留或完整提交、无残留）。
- [ ] **A3 写入门限与故障收敛（R2-⑤ + R4-⑭ + R5-③ 分离 handled/crash）**：active + A3-drift 状态下裸重跑 → 报告 drift 且 settings/.backup 逐字节零写入；同状态 `--apply` → 收敛 → 再跑零 diff；**handled I/O error**（注入 temp 写/rename 失败）→ A2/A4 输出 + exit 2 + settings 零改动；**kill fixture 按 crash contract 断言**（rename 前杀 = settings 逐字节原样、rename 后杀 = 新内容完整；不断言 stdout/stderr/exit）→ 两种情形 `--apply` 重跑均收敛 → 再跑零 diff；settings malformed JSON → A3 refusal + 人工引导（断言不降级 `{}`、不写入）。
- [ ] **remediation 入口可达性（R4-⑪ + R5-①）**：already-latest 机 + missing/drift 拓扑 → `--apply` 内 seam 补齐 + 归一单次原子写 → exit 0（断言全链无需第二条用户命令、无子进程 shell-out）；blast-radius 断言：写前后除 assembler 条目外 settings 其余内容（含 statusLine/model/无关 hook）逐字节不动。
- [ ] **drift 投影边界（R4-⑫）**：同 key 仅 command 漂移 / 仅 timeout 漂移 → 判 drift 且 `--apply` 收敛；同 key 加 `async:true`（投影外多字段）→ 判 same-key-manual → preflight refusal + exit 2 + settings 零改动 + 字段 diff 输出。
- [ ] **分类器表驱动断言（R9-①）**：same-key 条目对 exact-canonical / projection-only（仅 command、仅 timeout、两者同时）/ 任一投影外差异（`async`、缺字段、type 缺失/异常、投影内+投影外组合）逐 case 断言唯一分类（canonical / drift / same-key-manual），三格互斥且穷尽；投影内+投影外组合必须落 same-key-manual（不得因 command/timeout 也漂移而误判 drift）。
- [ ] **混合拓扑 preflight（R5-②）**：正交组合 fixtures（如 startup missing + clear duplicate-entry；startup drift + compact duplicate-group）→ 一律整体 refusal、settings 逐字节零改动、stderr 列全所有异常组；canonical 三组仅 missing/drift 混合（可伴随合法 foreign-only 非 canonical 组，R10-①）→ 单次原子写一并收敛。
- [ ] **committed cleanup residue（R4-⑬）**：注入 cleanup 失败 → 断言 commit 成功 + marker 完整 + `.bak` residue 保留 + exit 0 + stdout residue 提示（矩阵 A1w）；随后 active `--apply` 重跑 → recovery 前置门清扫 residue → 零残留 + A3 幂等；active 裸重跑 → 仅报告 residue、零写入。
- [ ] **schema-malformed topology（R6-② + R7-①）**：单类 fixtures（**settings 根 / `hooks` 容器的 null/数组/标量形态——含 `{"hooks":"legacy"}`、`{"hooks":[]}`** / SessionStart 非数组 / group 非 object / matcher present 非字符串 / group `hooks:{legacy:"keep"}` 非数组 / hook 元素非 object）+ 混合 fixtures（malformed 与 missing/drift/duplicate 并存）→ 一律整体 refusal + settings 逐字节零改动 + 精确 JSON 位置输出 + exit 2（A2/A4 行）；断言**不降级为 missing、不调用 seam、`hooks:{legacy:"keep"}` 原字节保留**；dry-run 同拓扑 → 报告同类异常预告、零写入。
- [ ] **matcher/type 分类唯一性（R7-①）**：matcher-absent catch-all foreign 组（仅 foreign 条目）→ 合法（不 refusal）、原样字节保留、不计入 canonical 三组；同 assembler-key（command 相同）但 `type` 缺失/异常 → same-key-manual refusal + exit 2 + settings 零改动 + 字段 diff 输出（真入口，断言**不判 foreign、不由 seam 补第二条同 command 条目**）；`command` 非字符串/缺失的 hook 元素 → foreign 原样保留。
- [ ] **misplaced assembler（R8-①）**：真入口 fixtures——assembler command 位于 matcher-absent 组 / matcher `''` 组 / 任意非 canonical matcher（如 `"resume"`）组，且 canonical 三组「齐」与「缺」各配一例 → 一律 preflight 整体 refusal + exit 2 + settings 逐字节零改动 + stderr 打印组 matcher/序号；断言 **canonical 组不被按 missing 补齐、seam 不被调用**；非 canonical 组中 wrong/missing `type` 的 assembler-key 条目同样按 key 捕获为 misplaced；不同 key 条目在任何组 = foreign 原样保留（不误伤）。
- [ ] **fresh 成功门全覆盖（R10-②）**：真入口 fixture——fresh A 类 + startup missing + clear drift（仅 command 漂移）+ 一个 ''/absent foreign-only 组 → 单次 `--apply`：事务提交 + seam 补齐/修正 + 归一 + foreign-only 组逐字节顺序保留 → 矩阵 A1（exit 0，成功报告 + backupPath，无第二命令）；重跑 `--apply` → A3r 幂等零 diff。
- [ ] **foreign-only 组共存合法性（R9-②）**：真入口 fixtures——①两个 matcher-absent/`''` foreign-only 组共存、②两个同名任意 matcher（如两个 `"resume"`）foreign-only 组共存 → 均**不报 duplicate-group、允许 `--apply` 收敛（seam 正常补齐 canonical）**、两组逐字节 + 顺序原样保留；③任一此类组加入 assembler-key 条目 → 唯一落 misplaced refusal（不同时报 duplicate-group）；④canonical matcher 值真重复（如两个 `startup` 组）→ duplicate-group refusal 不变。
- [ ] **residue × A3 组合（R6-③，矩阵 A2w）**：真入口 fixtures ①cleanup-failure × A3 preflight-refusal（如 clear duplicate-entry）、②cleanup-failure × A3 handled-I/O-error（注入 temp 写失败）→ 断言全链：marker 已提交 + residue 保留且 stdout 显式报告 + settings 逐字节零改动 + stderr A3-remediation + exit 2；随后重跑 `--apply`：recovery 前置门先清扫 residue，拓扑修复 / 注入解除后 → exit 0 收敛、零残留、再跑零 diff。
- [ ] **A3 异常拓扑（R2-⑥ + R3-⑨⑩ + R5-①② 修订，每例断言精确后置条件 + remediation 文案）**：duplicate-entry（同组两条 assembler-key）→ preflight refusal + settings 逐字节不动 + stderr 人工修复定位（不得引导 hook-sync——它不去重）；missing / drift → **`--apply` 同命令内 seam 收敛 + exit 0**（不再输出任何第二条命令引导；dry-run 输出「`--apply` 将补齐/修正」预告）；duplicate-group → preflight refusal + 人工修复引导；foreign 同 basename 不同路径（key 不同）→ 判 foreign、不计数、不移动、不出现在异常报告；canonical 态 → 归一后所有 foreign hook 深度相等 + 顺序不变，重跑零 diff。
- [ ] **CLI 结果矩阵全行覆盖（R3-⑧ + R4-⑬ + R6-③ + R7-②）**：真入口子进程逐行验证 Design 7 矩阵 D1/D2/A1/A1w/A2/A2w/A3r/A4/R1/R2/F1/F2 的 stdout 内容、stderr 内容、exit code、事务/marker/settings 后置状态；exit 2 行额外验证「remediation 后重跑 `--apply` → exit 0 收敛」链。
- [ ] **CLI 真入口**：子进程执行 `cli/zylos.js migrate-instructions` 的 dispatch、flags 解析（未知 flag 拒绝）；结果矩阵行的详细断言见上条（现 bin.test.js 只测 component symlink，与命令路由无关，需新增）。
- [ ] **指令架构版本标记**：`--apply` A 类成功 → `.zylos/instruction-format-version` 存在且内容 = `2\n`；`activateFreshSplitInstructions` → 同值；写入失败注入 → marker 已提交 + stderr 警告 + exit 0（不降级）+ 重跑补写；幂等重跑 → 同值不变。
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
