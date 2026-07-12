# Dev Plan: self-upgrade success path deletes conflict backups (#717)

## Summary

修复升级流程中最后一个静默丢数据的口子：self-upgrade 非 JSON 成功路径会把冲突备份连同临时备份目录一起删除，且不打印冲突文件路径；顺带修掉内容逐字节相同仍被判 conflict 的误报。Issue: zylos-ai/zylos-core#717（双机实测 + 双人源码核实，Howard 已拍板发版前收敛）。

## Scope

**In scope**
- 冲突备份与临时事务回滚备份的生命周期分离（问题 A）
- 非 JSON 成功路径输出冲突明细（问题 A）
- `!savedHash` 分支内容相等短路（问题 B）
- 上述行为的回归测试

**Out of scope**
- JSON 分支行为（现状正确：输出明细、不删 conflicts 前提下按现契约走）——仅需回归测试确认不被本次改动破坏
- component upgrade（非 self）路径的同类审查——如实现时发现同样问题，只记录到 issue 评论，不在本 PR 扩大修复面
- 备份保留策略/自动清理旧冲突备份（可后续单开 issue）
- 进度计数 /12→/13 跨版本交接现象（已定性非缺陷，不处理）

## Design Decision（本计划唯一新决策，预判 Howard 会同意，按 #35 先行）

**冲突备份落点从 `os.tmpdir()/zylos-core-backup-<ts>/conflicts/` 迁至 `~/zylos/.backup/<ts>/conflicts/`（持久、不参与 cleanupBackup）。**

理由：
1. 文档 `references/upgrade.md` 本来就写的是 `.backup/<timestamp>/conflicts/<path>` —— 这是向文档契约回归，不是发明新契约；
2. /tmp 本质是易失存储，重启即丢，作为"用户本地修改的唯一副本"的存放点从一开始就不合适；
3. `cleanupBackup()` 与 step1 事务回滚备份（服务文件、pm2 配置等，量大、确实该删）继续保持现行为，零行为回归。

实现要点：step5 `sync_core_skills` 的 `conflictBackupDir` 不再从 `ctx.backupDir` 派生，改为独立的 `~/zylos/.backup/<ts>/conflicts/`；`ctx` 上单独记录该路径并透传到 result，供输出与 JSON 使用。

## Development Checklist

- [ ] `cli/lib/self-upgrade.js`：新增独立 `conflictBackupDir`（`~/zylos/.backup/<ts>/conflicts/`），step5 使用之；`buildSelfUpgradeResult` 透出 `conflictBackupDir`
- [ ] `cli/lib/smart-merge.js`：`!savedHash` 分支先比较 `currentHash === newHash`，相等则归类 `overwritten`（内容一致，无需动作/备份），不再计 conflict
- [ ] `cli/commands/component.js` self-upgrade 成功分支（非 JSON）：当 `result.mergeConflicts` 非空时，逐条打印 `file → backupPath`，并提示后续可人工 re-merge
- [ ] `cleanupBackup(result.backupDir)` 保持现行为（只删临时事务备份）；确认删除范围不再包含冲突备份
- [ ] 若冲突备份目录本次为空（无冲突），不创建空目录（避免留垃圾）
- [ ] `component-management/references/upgrade.md` 如有措辞与新落点不一致处，同步修正（预期基本一致，因为本来就写 `.backup/`）

## Test Checklist

- [ ] 单测（smart-merge）：`!savedHash` + 内容相同 → 归类 overwritten、conflicts 为空、无备份文件产生
- [ ] 单测（smart-merge）：`!savedHash` + 内容不同 → 仍判 conflict、备份写入指定 conflictBackupDir
- [ ] 回归（self-upgrade driver，仿 #716 的 test/helpers/run-upgrade-driver.mjs 模式）：成功升级 + 有冲突 → (a) `~/zylos/.backup/<ts>/conflicts/` 下备份文件存在且内容为本地旧版；(b) 非 JSON stdout 含每个冲突文件路径与备份路径；(c) 临时 backupDir 已被清理
- [ ] 回归：成功升级 + 无冲突 → 不产生 .backup 冲突目录
- [ ] 回归：JSON 模式输出的 `mergeConflicts[].backupPath` 指向新落点且文件存在
- [ ] 全量：Jest + node 测试套件全绿（基线 141/141 + 687/687，允许因新增测试而增长）

## Assumptions

- [ ] `~/zylos/` 在 self-upgrade 运行时始终存在且可写 —— 系统保证（ZYLOS_DIR 是安装根，upgrade 本身在其中读写）
- [ ] step1 的临时事务备份仍需完整删除（含服务副本），没有其他消费方依赖它在成功后存活 —— 需实现时 grep 确认（`backupDir` 的全部读方）
- [ ] JSON 分支现状不调用 `cleanupBackup`（jinglever 源码核实结论）—— 需实现时复核，如 JSON 分支也删，则同样修复并补测试
- [ ] `currentHash`/`newHash` 在 `!savedHash` 分支必然已计算（manifest 生成覆盖全部文件）—— 需实现时确认对二进制/大文件同样成立

## Acceptance Checklist

- [ ] 验收点 1（问题 A）：真机复现场景下（构造 manifest 未登记且与包内容不同的文件），升级成功后冲突备份存活于 `~/zylos/.backup/<ts>/conflicts/`，stdout 列出文件与备份路径
- [ ] 验收点 2（问题 B）：构造 manifest 未登记但内容与包内一致的文件，升级后不报 conflict、不产生备份
- [ ] 临时 backupDir 成功后仍被清理（现行为无回归）
- [ ] 全量测试通过（Jest + node）
- [ ] `git diff --check` 干净
- [ ] 无 UI 面，无需浏览器验证
