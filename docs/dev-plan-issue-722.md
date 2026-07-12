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

**组装器与模板**
- [ ] `assembler.mjs`：dependency-free leaf（无 config.js/import 隐式依赖；显式入参 `{systemPath, userPath, outputPath, ephemeralContext?}`）；原子写（tmp + rename）；输出头注释写明三层来源（系统文件路径 / 用户 ZYLOS.md / 生成时间）
- [ ] `needsRebuild()` 语义并入 leaf 或其薄封装：比较 system file + user ZYLOS.md mtime vs 生成物，常态开销 ≈ 两次 stat
- [ ] `templates/claude-system.md` = 现 templates/ZYLOS.md 正文 + claude-addon.md（逐字节合并，头部加「系统管理，升级覆盖，自定义请写 ~/zylos/ZYLOS.md」块）
- [ ] `templates/codex-system.md` = 同上 + codex-addon.md
- [ ] `templates/ZYLOS.md` 改为一行 seed 说明（「用户自定义内容写在这里」），装机时 seed 一次
- [ ] 删除 `templates/CLAUDE.md`、`templates/claude-addon.md`、`templates/codex-addon.md`（addon 已并入系统文件）；退役 `self-upgrade.js` 中 `syncClaudeMd()` 遗留路径
- [ ] 系统文件内容审计：不含任何机外引用（repo docs/ 链接等）

**物化与触发**
- [ ] init / self-upgrade 部署 system files + assembler.mjs 到 `~/zylos/.zylos/instructions/`（升级覆盖；删 npm 包后组装照常）
- [ ] Claude：SessionStart hook（startup + clear matcher）调物化组装器，入口先 `needsRebuild()`；Guardian launch 前组装保留为兜底（时序是实测行为非文档契约）
- [ ] Codex：组装只挂 launch boundary（Guardian 调 adapter.launch 前）；adapters 自身不再拼文件，launch boundary 留窄断言防绕过
- [ ] `memorySnapshot` 作组装器显式单次入参（ephemeral），永不持久化进稳定生成物；Guardian 现未传它（预留 seam），按需接线不扩scope

**流程收编**
- [ ] `instruction-builder.js`：`buildInstructionFile()` 委托 canonical assembler；消灭 self-upgrade step7 / migrate.js / instruction-builder 三处重复拼接实现
- [ ] self-upgrade step7 重写：从 `ctx.tempDir` 新包部署 → 用**新版**组装器原子重组装；step 备份/ownership 清单同步调整（现把三个 .md 全纳入 rollback 的列表要改）
- [ ] `migrate.js` 独立重建逻辑统一到 canonical assembler
- [ ] init：seed 一行版 ZYLOS.md（缺失时）+ 物化 + 组装；re-init 顺序差异（先 skill 后 migrate）由 leaf 设计免疫——加断言验证

## Test Checklist (P1)

- [ ] fresh init → CLAUDE.md/AGENTS.md 三层结构正确、头注释正确
- [ ] re-init（已有用户 ZYLOS.md）→ 用户内容不被覆盖
- [ ] runtime switch（claude ↔ codex）→ 各自生成物正确
- [ ] self-upgrade 跨版本 launcher-finalizer 路径 → step7 部署+重组装原子完成；rollback 清单正确
- [ ] skill 缺失修复场景：物化 assembler 丢失时 registry/CLI 命令仍能加载包内同源副本修复
- [ ] 删 npm 包实验：物化副本独立完成组装
- [ ] Claude /clear 时序 smoke 断言（同会话可见——沙箱 tmux + marker，复用 triage 实验方法）
- [ ] Codex 同进程不重读 negative control（防未来误挂 turn-level 触发）
- [ ] 原子写：组装中途 kill 不留半成品
- [ ] memorySnapshot 不串代：传入 ephemeral 后生成物稳定段无残留
- [ ] 全量 `npm test` 687+ 绿；lint 干净

## Assumptions

- [ ] 历史模板语料可从 repo git history 完整枚举（released tags 的 templates/ZYLOS.md blobs）——P2 迁移 step-0 的前提，**需在 P1 期间验证**（若缺 tag 需补全语料来源）
- [ ] v0.1.8–v0.3.6 为共享同一 blob 的模板家族（jinglever 实测），baseline 匹配按家族处理，无需唯一版本
- [ ] Claude 2.1.207 SessionStart hook 同会话可见为**实测行为非文档契约** → Guardian 兜底必须保留（已定案，此处只记录依据）
- [ ] Codex 0.137.0 活进程不重读 AGENTS.md（jinglever 实测）→ launch-only 触发充分
- [ ] Guardian 现不传 memorySnapshot（预留 seam）——实现按「显式入参、默认不传」处理，不新增行为
- [ ] `~/zylos/.zylos/` 在全部存量机上存在且系统属地（components.json 已在此）——若个别机缺失，物化时 mkdir -p 即可
- [ ] pre-v0.4 机（无 ZYLOS.md）在 `zylos init` 迁移路径中处理，`syncClaudeMd()` 删除不致其失联——**需验证该路径覆盖**

## Acceptance Checklist

- [ ] 沙箱 fresh install：生成物三层结构 + 头注释正确；系统文件无机外引用
- [ ] 沙箱 v0.5.3 → 新版 upgrade：system files 落位、生成物重组装、用户 ZYLOS.md 未被动
- [ ] 用户改 ZYLOS.md → 下一次 session（startup 与 /clear 两路径）生效，实机验证
- [ ] 删 npm 包 → session 边界组装照常（物化独立性）
- [ ] luna.coco 本机 dogfood 全链路（P1 出口 gate，过后才开 P2）
- [ ] 全量测试绿 + lint 干净 + CI 绿
- [ ] 无回归：custom shard 注入、memory 注入、heartbeat 等 session-start 链路行为不变
