# Dev Plan: ZYLOS.md 拆层重构 — system/user split-layer instructions (#722)

## Summary

把每台机的指令文件从「模板正文 + 用户内容混在一个 ZYLOS.md」拆成两层：系统段（升级覆盖）+ 用户段（永不合并）。系统文件与无依赖组装器物化到 `~/zylos/.zylos/instructions/`，monitor 在 session 边界组装，模板改进从此可随升级触达全部存量机。

设计基准（不重开已定决策）：提案 [comment 4951266232](https://github.com/zylos-ai/zylos-core/issues/722#issuecomment-4951266232) + Howard 共识定案 [comment 4951355748](https://github.com/zylos-ai/zylos-core/issues/722#issuecomment-4951355748)（5 点：①落点 `.zylos/instructions/` ②迁移三分类 ③三阶段推广 ④删 `templates/CLAUDE.md` + 退役 `syncClaudeMd()` ⑤addon 并入系统文件）。另一硬约束：**agent 可见指令文件不得引用不落进 ~/zylos 的资源**（Howard 2026-07-12，#721 尾声）。

## Scope

**In（本 Issue，按阶段分 PR）**
- P1 机制：组装器 leaf + 系统文件模板 + 物化 + 触发点接线（Claude SessionStart hook / Codex launch boundary / Guardian 兜底）+ init/self-upgrade/migrate 改造 + 测试。**本分支 = P1。**
- P2 迁移：三分类迁移工具（step-0 baseline 检测 + A/B/C 流水线 + #717 备份 + 逐行守恒检查 + seed 元数据），P1 在 luna.coco 机验证后另开 PR。
- P3 收尾：fleet 迁移指引、文档、CHANGELOG（吸收 #719 存量手改清单）。

**Out**
- #720 symlink 硬化（独立决策，Howard 未拍）
- custom shard 机制本身（不动）
- 指令内容的改写（只搬运不改写；系统文件内容 = 现 templates/ZYLOS.md 正文 + 对应 addon，逐字节搬运）

## Development Checklist (P1)

**激活门控（R1+R2 修订 — split assembly 与迁移同一事务边界）**
- [ ] **split-v1 marker**：`~/zylos/.zylos/instructions/meta.json`（= seed 元数据文件）作为激活开关——**只有 marker 存在时才走 split assembly**。写入者仅两个：fresh init 与 P2 迁移工具
- [ ] **marker = commit record（R2）**：两个写入者共同遵守同一提交协议——system files、seed ZYLOS.md、两个生成物全部 staging 成功后，marker 作为**最后一步原子 rename** 落位；marker 出现之前的任何失败都保持未激活状态且**可重试**（无半完成 generation 残留）。单文件 tmp+rename 只保护单文件，跨文件事务由「marker 最后写」这一顺序保证
- [ ] **无 marker 的存量机（P1 升级落地后）**：物化 system files + assembler，但**不重组装、不触碰既有 CLAUDE.md/AGENTS.md**（逐字节保持原样 = 保持旧行为），self-upgrade 输出醒目的 pending-migration 提示；用户改 ZYLOS.md 暂不生效（与 pre-#722 现状一致，严格保守）
- [ ] 负面守卫：assembler/触发点在无 marker 时对存量生成物是严格 no-op；绝不允许「新 system + 旧 ZYLOS.md（含旧模板正文）」被拼出来（双重系统段）

**组装器与模板**
- [ ] `assembler.mjs`：dependency-free leaf（无 config.js/import 隐式依赖；显式入参 `{systemPath, userPath, outputPath}`——**无 ephemeral 参数，R2 收缩**）；原子写（tmp + rename）；输出头注释写明来源（系统文件路径 / 用户 ZYLOS.md / 生成时间）
- [ ] `needsRebuild()` 语义并入 leaf 或其薄封装：比较 system file + user ZYLOS.md mtime vs 生成物，常态开销 ≈ 两次 stat
- [ ] `templates/claude-system.md` = 现 templates/ZYLOS.md 正文 + claude-addon.md（逐字节合并，头部加「系统管理，升级覆盖，自定义请写 ~/zylos/ZYLOS.md」块）
- [ ] `templates/codex-system.md` = 同上 + codex-addon.md
- [ ] `templates/ZYLOS.md` 改为一行 seed 说明（「用户自定义内容写在这里」），装机时 seed 一次
- [ ] 删除 `templates/CLAUDE.md`、`templates/claude-addon.md`、`templates/codex-addon.md`（addon 已并入系统文件）；退役 `self-upgrade.js` 中 `syncClaudeMd()` 遗留路径
- [ ] 系统文件内容审计：不含任何机外引用（repo docs/ 链接等）

**物化与触发**
- [ ] init / self-upgrade 部署 system files + assembler.mjs 到 `~/zylos/.zylos/instructions/`（升级覆盖；删 npm 包后组装照常）
- [ ] Claude：SessionStart 组装接入**现有 canonical hook 拓扑**（`session-start-orchestrator` / `sync-settings-hooks.js` 的 `buildChain()` 体系），以**显式 runtime gate（Claude-only）**挂载——**不得**作为 shared core shard/side-effect 进共享链（否则 `codex-hooks.js` 同源生成会让 Codex 进程启动后 late assemble），也不得另起一条不受 canonical reconciliation 管理的平行 hook。matcher 覆盖 startup + clear；**compact 策略：同样挂载，靠 `needsRebuild()` 门控（未变更时为纯 stat no-op）**。入口先 `needsRebuild()`；Guardian launch 前组装保留为兜底（时序是实测行为非文档契约）
- [ ] Codex：组装只挂 launch boundary（Guardian 调 adapter.launch 前）；`codex-hooks.js` 生成的 SessionStart command list **必须不含 assembler**；adapters 自身不再拼文件，launch boundary 留窄断言防绕过
- [ ] **memorySnapshot seam 直接移除（R2 方案①）**：Guardian 从未传它（死 seam），且「入参又不落盘」与现存唯一消费路径（`instruction-builder.js:83-87` append 进 AGENTS.md + `codex.js:237-238` launch 前读取）自相矛盾——删除 assembler 的 ephemeral 概念与旧 AGENTS-append seam，本 Issue 不新增行为；未来 Codex 若需要 snapshot 注入，另立 issue 设计 transient artifact 生命周期

**流程收编**
- [ ] `instruction-builder.js`：`buildInstructionFile()` 委托 canonical assembler；消灭 self-upgrade step7 / migrate.js / instruction-builder 三处重复拼接实现
- [ ] self-upgrade step7 重写：从 `ctx.tempDir` 新包部署 → **有 marker** 时用新版组装器原子重组装 / **无 marker** 时只物化+保持生成物原样+pending-migration 提示；step 备份/ownership 清单同步调整（现把三个 .md 全纳入 rollback 的列表要改）；pre-v0.4 机的 `runMigrations()` 失败从「静默 fallback 到 syncClaudeMd」改为**响亮失败**（fallback 路径已删），且 migration 自身必须原子：失败时原 CLAUDE.md 逐字节保持、不留部分 system files/seed metadata、可重试恢复（既定「post-install 不做 outer rollback」合同下，靠 migration 自身守恒而非外层回滚）
- [ ] `migrate.js` 边界收编（R1）：迁移逻辑接收**显式 `zylosDir` / `templatesDir` 入参**，消灭 module-level `ZYLOS_DIR` 隐式绑定（step7 已有 `ctx.zylosDir`，两侧对齐）——否则隔离测试/非默认目录会误读写 live root
- [ ] `migrate.js` 独立重建逻辑统一到 canonical assembler
- [ ] init：seed 一行版 ZYLOS.md（缺失时）+ 物化 + 组装；re-init 顺序差异（先 skill 后 migrate）由 leaf 设计免疫——加断言验证

## Test Checklist (P1)

- [ ] fresh init → marker 最后写入 + CLAUDE.md/AGENTS.md 两层结构正确、头注释正确
- [ ] **fresh-init 注入失败 gate（R2 新增）**：在 staging（system files / seed / 生成物 / marker rename）各点注入写失败 → 无 marker、无半完成 generation 残留、重试成功即达终态
- [ ] **unknown-baseline 负面 fixture（R2 新增）**：构造「不可达真实模板 = catalog candidate + X，当前文件 = 真实模板 + 用户 Y」样本 → 必须判 C（catalog 内唯一 pure-add 不得自动升 B）
- [ ] re-init（已有用户 ZYLOS.md + marker）→ 用户内容不被覆盖
- [ ] runtime switch（claude ↔ codex）→ 各自生成物正确
- [ ] self-upgrade 跨版本 launcher-finalizer 路径 → 有 marker：step7 部署+重组装原子完成；rollback 清单正确
- [ ] **激活门控负面 fixtures（R1 新增）**：无 marker 的 A/B/C 三类存量 fixture 上跑新版 upgrade + session 触发点 → 生成物**逐字节不变** + pending-migration 提示；断言绝不出现双重系统段/旧 core 被当 user 段拼装
- [ ] **pre-v0.4 真实升级 gate ①（R1 新增）**：only-CLAUDE.md/无 ZYLOS.md fixture → runMigrations() 成功迁移，旧内容逐行守恒，结果符合激活门控（无 marker 不激活）
- [ ] **pre-v0.4 真实升级 gate ②（R1 新增）**：注入 migration/rename 失败 → step7/finalizer **响亮失败**（非 skip/吞错）；原 CLAUDE.md 逐字节保持、无部分 system files/seed metadata 残留、重试可恢复
- [ ] **hook 接线断言（R1 新增）**：Claude settings 中 assembler 于 startup/clear/compact 各恰好一次；**Codex SessionStart command list 不含 assembler**；hook sync 收敛幂等（重跑不重复）且保留 user hooks/custom shards
- [ ] skill 缺失修复场景：物化 assembler 丢失时 registry/CLI 命令仍能加载包内同源副本修复
- [ ] 删 npm 包实验：物化副本独立完成组装
- [ ] Claude /clear 时序 smoke 断言（同会话可见——沙箱 tmux + marker，复用 triage 实验方法）
- [ ] Codex 同进程不重读 negative control（防未来误挂 turn-level 触发）
- [ ] 原子写：组装中途 kill 不留半成品
- [ ] memorySnapshot seam 移除断言：assembler API 无 ephemeral 参数；旧 append 代码路径删除；AGENTS.md 生成物在任何路径下不含 snapshot 内容
- [ ] 全量 `npm test` 687+ 绿；lint 干净

## Assumptions

- [x] **baseline 语料（R1 修正后的事实）**：44 个 v-tag 内 templates/ZYLOS.md = 4 distinct blobs / templates/CLAUDE.md = 5 blobs（luna.coco 验证）；但 **branch install/upgrade 是正式支持路径**（README `install.sh --branch`、component.js branch self-upgrade），全 repo 可达历史 ZYLOS.md 实为 **22 个 distinct blobs**，且已删分支/不可达 commit 也可能 seed 过机器（jinglever R1 实证）。**结论：catalog = 全部可达历史 template blobs（`git rev-list --all` 枚举，ZYLOS.md + CLAUDE.md 两个 path），且 catalog 不承诺完备**
- [ ] **B 类判定标准（R1 收紧 + R2 反循环）**：自动判 B 需要**独立于 diff 的 authoritative provenance 证据**（可验证的安装 manifest / `.zylos/originals` 记录 / 已记录 seed hash）精确命中 catalog，且残差 hunks 全部为可证纯新增。**「catalog 内唯一 pure-add 残差」本身不构成证据**——从同一 diff 反推 baseline 是循环证明（反例：不可达真实模板 = candidate+X 时，X 会被错归为用户内容）。无独立证据的 legacy 机：生成候选拆分报告但**保守判 C**；若现实中没有任何 legacy provenance ledger，接受**自动 B 集合为空**。注：A 类不受影响——「当前文件 ≡ catalog 某 blob」是内容级证明，与 provenance 无关（真实 seed 即使是不可达版本，内容也必然相同，置空无风险）
- [ ] v0.1.8–v0.3.6 为共享同一 blob 的模板家族（jinglever 实测），baseline 匹配按家族处理，无需唯一版本
- [ ] Claude 2.1.207 SessionStart hook 同会话可见为**实测行为非文档契约** → Guardian 兜底必须保留（已定案，此处只记录依据）
- [ ] Codex 0.137.0 活进程不重读 AGENTS.md（jinglever 实测）→ launch-only 触发充分
- [x] Guardian 从不传 memorySnapshot（jinglever Q2 实证，死 seam）→ R2 决定直接移除该 seam（见 Development Checklist），本 Issue 不新增行为
- [ ] `~/zylos/.zylos/` 在全部存量机上存在且系统属地（components.json 已在此）——若个别机缺失，物化时 mkdir -p 即可
- [x] ~~pre-v0.4 机在迁移路径中处理~~ **已验证（2026-07-12，self-upgrade.js step7 阅读）**：pre-v0.4 机（无 ZYLOS.md）在 step7 里**先走 `runMigrations()`**（从其 CLAUDE.md 生成 ZYLOS.md）→ 成功即进 v0.4+ 重建路径；`syncClaudeMd()` 仅是 **migration 失败时的静默 fallback**。结论：删除它可行，但新 step7 必须把「migration 失败」改为**响亮失败**（报错出来），不能再静默降级到一条已删除的路径。此要求补进 Development Checklist 的 step7 重写项

## Acceptance Checklist

- [ ] 沙箱 fresh install：marker 写入、生成物两层结构 + 头注释正确；系统文件无机外引用
- [ ] 沙箱 v0.5.3 → 新版 upgrade（无 marker）：system files 物化落位、**生成物逐字节未变** + pending-migration 提示、用户 ZYLOS.md 未被动（R1 修订：升级不激活）
- [ ] 用户改 ZYLOS.md →（已激活的 fresh-init 沙箱 fixture）下一次 session（startup 与 /clear 两路径）生效
- [ ] 删 npm 包 → session 边界组装照常（物化独立性）
- [ ] **P1 出口 gate（R2 修订——本机不迁移，fixture 分工归位）**：① luna.coco 真实机：新版升级落地 → 物化完成、**生成物逐字节不变** + pending 提示（保守路径的真机验证）——本机保持 no-marker 原始状态，**作为 P2 正式迁移工具的第一个真实 A 类样本**；② activated 全链路（startup / clear / compact / 改 ZYLOS.md 生效 / 删包实验）在 **fresh-init 沙箱 fixture** 上验证。marker 写入者严格保持两个（fresh init / P2 工具），P1 不做任何手工迁移例外
- [ ] 全量测试绿 + lint 干净 + CI 绿
- [ ] 无回归：custom shard 注入、memory 注入、heartbeat 等 session-start 链路行为不变
