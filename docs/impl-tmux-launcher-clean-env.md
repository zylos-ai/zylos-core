# 实施文档：tmux-launcher 干净环境方案

**PR branch**: `feat/tmux-launcher-clean-env`
**方案文档**: `proposal-clean-env-v2` (internal)
**环境概念**: `env-concepts-tmux-session` (internal)
**日期**: 2026-05-09

---

## 目标

一步到位将 tmux session 启动从「shell source 机制」迁移到「launcher 管道」，实现 Level 1 环境变量 allowlisting。**新建 runtime session 的唯一启动路径走 launcher**；existing session 分支保留 sendMessage 注入命令，不做 clean env 重建。

## 变更概览

### 新增文件

| 文件 | 职责 |
|------|------|
| `cli/lib/runtime/tmux-env.js` | 环境构建核心：env 构建、manifest 解析、spec 文件 I/O、模板部署 |
| `cli/lib/runtime/tmux-launcher.js` | CLI 入口：读取 spec → 删除文件 → spawn child → 透传 exit code |
| `cli/lib/__tests__/tmux-env.test.js` | tmux-env.js 单元测试（54 tests） |
| `cli/lib/__tests__/tmux-launcher.test.js` | tmux-launcher.js 单元测试 |
| `cli/lib/__tests__/runtime-launch.test.js` | claude.js / codex.js launch() 集成测试——tmux cmdline 安全、spec.env 正确性 |
| `templates/runtime-env.manifest.example` | runtime-env.manifest 模板——注释 + 示例，TZ 默认启用 |

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `cli/lib/runtime/claude.js` | `launch()` 方法重写——新建 session 走 launcher 管道，删除 shell source 机制；existing session 保留 sendMessage。加载 manifest 并传给 `buildCleanEnv()` |
| `cli/lib/runtime/codex.js` | `launch()` 方法重写——新建 session 走 launcher 管道；existing session 保留 sendMessage（含 bootstrap prompt）。加载 manifest 并传给 `buildCleanEnv()` |
| `cli/commands/init.js` | `deployTemplates()` 末尾调用 `deployManifestTemplate()` 从模板复制 manifest（仅缺失时） |
| `cli/lib/self-upgrade.js` | `step7_syncClaudeMd()` 中调用 `deployManifestTemplate()` 确保升级到含模板版本时 existing install 也得到 manifest |
| `scripts/run-node-tests.js` | 添加 `--experimental-test-module-mocks` flag 以支持 runtime-launch.test.js 的 `mock.module()` |
| `.gitignore` | 添加 `.zylos/runtime-env.manifest` 规则，防止用户正式配置被提交 |

### 不改动的文件

- `base.js` — 接口不变
- `checkAuth()` — 认证逻辑不变
- `isRunning()` / `stop()` / `sendMessage()` — tmux session 操控逻辑不变
- `getHeartbeatDeps()` / `getContextMonitor()` — 心跳和上下文监控不变
- `instruction-builder.js` / `session-handoff.js` — 不涉及
- 已有测试文件 — 不受影响

---

## 详细设计

### 1. tmux-env.js

核心模块，纯函数设计，不依赖 tmux/child_process，方便单元测试。

#### 导出 API

```javascript
// ── Manifest 解析 ──

/** 解析 runtime-env.manifest 文件内容。Line-based 格式：env/inherit/path_prepend/path_append。 */
export function parseRuntimeEnvManifest(content, warnings = [])
// → { envNames: string[], inheritNames: string[], pathPrepend: string[], pathAppend: string[] }

/** 从 ZYLOS_DIR/.zylos/runtime-env.manifest 加载并解析。文件缺失返回空 manifest。 */
export function loadRuntimeEnvManifest(zylosDir, warnings = [])
// → 同上

/** 从模板复制 manifest 到 ZYLOS_DIR/.zylos/runtime-env.manifest（仅缺失时）。 */
export function deployManifestTemplate(templatePath, zylosDir)
// → boolean (true = 已创建, false = 已存在或模板缺失)

/** 解析逗号分隔的 PATH manifest 为绝对路径数组。相对路径跳过 + warning。 */
export function parsePathManifest(value, warnings, keyName)
// → string[]

/** 解析逗号分隔的变量名列表。非法名跳过 + warning。 */
export function parseManifest(manifestStr, warnings = [])
// → string[]

// ── 环境构建 ──

/**
 * 构建干净环境对象（ZYLOS_CLEAN_ENV=true）。
 * 合并 manifest 文件 directives 与 legacy .env keys，manifest 条目优先。
 */
export function buildCleanEnv({ processEnv, dotenvVars, manifest, platform, uid })
// → { env: Object, warnings: string[] }

/**
 * 构建兼容环境对象（ZYLOS_CLEAN_ENV=false，默认）。
 * 完整传入 processEnv + manifest 变量覆盖 + PATH dedupe。
 * 不读取 runtime-env.manifest 文件，不注入 GH_PROMPT_DISABLED / Homebrew paths / PATH manifest。
 */
export function buildCompatEnv({ processEnv, dotenvVars })
// → { env: Object }

// ── Spec 文件 I/O ──

/** 将 launch spec 写入临时 JSON 文件（mode 0o600）。 */
export function writeLaunchSpec(spec)
// → specPath (string)

/** 读取并立即删除 spec 文件（unlink-before-spawn 安全模式）。 */
export function readAndDeleteSpec(specPath)
// → spec object
```

#### buildCleanEnv 逻辑

```
1. 合并 PATH manifest:
   - manifest.pathPrepend + ZYLOS_TMUX_PATH_PREPEND 合并去重（manifest first）
   - manifest.pathAppend + ZYLOS_TMUX_PATH_APPEND 合并去重（manifest first）
   - _buildPath() 拼接最终 PATH

2. 基础集合（硬编码）:
   PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TERM, SHELL

3. Agent 自动化:
   GH_PROMPT_DISABLED=1（防止 gh CLI 交互式 prompt）

4. 平台特定:
   - macOS (darwin): TMPDIR（从 processEnv 继承，若存在）

5. Built-in allowlist exceptions（从 processEnv 自动继承，无需用户声明）:
   - proxy: HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy, https_proxy, no_proxy
   - 沙箱: IS_SANDBOX（从 processEnv 继承；若 uid=0 且 processEnv 无值则自动设为 '1'）

6. env directives（从 dotenvVars 读值）:
   - manifest.envNames + ZYLOS_TMUX_ENV 合并去重（manifest first）
   - 从 dotenvVars 读取每个变量的值

7. inherit directives（从 processEnv 读值，低于 env 优先级）:
   - manifest.inheritNames + ZYLOS_TMUX_INHERIT 合并去重（manifest first）
   - 仅在 env 未覆盖时从 processEnv 读取

8. Auth tokens:
   - Claude: 调用方在 env build 后根据 native auth 状态注入/移除 auth env
   - Codex: 不注入 auth env；Codex CLI 通过 HOME 读取 ~/.codex/auth.json
   - tmux-env.js 本身不处理 auth
```

#### PATH 构建顺序

```
~/.local/bin, ~/.claude/bin          ← 永远最高优先（用户工具）
nvm segments                         ← 从 process.env.PATH 提取 .nvm 段
PREPEND (manifest + .env)            ← 用户配置，高于系统路径
/opt/homebrew/bin, /opt/homebrew/sbin (darwin) ← macOS Homebrew built-in default
/usr/local/sbin, /usr/local/bin      ← 系统 local
/usr/sbin, /usr/bin, /sbin, /bin     ← 系统
APPEND (manifest + .env)             ← 用户配置，低于系统路径
→ dedupe (保留 first occurrence)
```

### 2. runtime-env.manifest

#### 文件路径

| 用途 | 路径 |
|------|------|
| 仓库模板（tracked） | `templates/runtime-env.manifest.example` |
| 用户正式文件（local） | `$ZYLOS_DIR/.zylos/runtime-env.manifest` |

- 正式文件通过 `.gitignore` 排除，防止提交用户配置
- init / self-upgrade 时从模板复制到正式路径（仅缺失时创建，绝不覆盖用户改动）
- `deployManifestTemplate()` 实现复制逻辑，在 `deployTemplates()` (init) 和 `step7_syncClaudeMd()` (self-upgrade) 中调用
- claude.js / codex.js 在 clean env 模式下调用 `loadRuntimeEnvManifest(ZYLOS_DIR)` 读取

#### Directive 格式

```text
# 注释行
env NAME           # 从 ~/zylos/.env 读取 NAME 注入 runtime
inherit NAME       # 从 supervisor (AM/PM2) process.env 继承 NAME
path_prepend PATH  # 在系统路径前添加 PATH（仅接受绝对路径）
path_append PATH   # 在系统路径后添加 PATH（仅接受绝对路径）
```

#### Validation 规则

- 空行 / `#` 注释跳过
- env/inherit 用 `/^[A-Za-z_][A-Za-z0-9_]*$/` 校验变量名
- path_prepend/path_append 只接受绝对路径（以 `/` 开头）
- unknown directive → warning
- missing argument → warning
- too many tokens → warning
- 不支持 shell 展开（`~`/`$HOME`/引号）

#### 与 .env keys 的合并

manifest 条目与 legacy `.env` keys 合并去重，manifest 优先（listed first in dedup）：

| manifest directive | .env key | 合并方式 |
|---|---|---|
| `env NAME` | `ZYLOS_TMUX_ENV=A,B,C` | 合并去重，manifest first |
| `inherit NAME` | `ZYLOS_TMUX_INHERIT=A,B,C` | 合并去重 |
| `path_prepend /path` | `ZYLOS_TMUX_PATH_PREPEND=/a,/b` | 合并去重，manifest first |
| `path_append /path` | `ZYLOS_TMUX_PATH_APPEND=/a,/b` | 合并去重，manifest first |

env 仍 win over inherit（同名变量同时出现时，env 优先）。compat mode 完全不受 manifest 影响。

### 3. tmux-launcher.js

最小化 CLI 入口，只做四件事：

```javascript
// 1. 读取 argv[2] 指定的 spec.json
// 2. 删除 spec 文件（unlink-before-spawn）
// 3. spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: 'inherit' })
// 4. 透传 exit code / signal（128 + signalNumber）
```

信号透传：收到 SIGTERM / SIGINT / SIGHUP → child.kill(signal)。child 被信号终止时，launcher 按 `128 + signalNumber` 退出（POSIX convention）。

### 4. tmux `new-session -E` boundary

tmux `new-session` 默认会将 tmux server 的全局环境（`update-environment` 列表）合并到新 session，可能导致旧环境变量泄漏到新 session。`-E` flag 禁止这种行为：

```bash
tmux new-session -d -E -s SESSION -- "node tmux-launcher.js spec.json"
```

这确保 session 内的 environment 完全由 launcher 通过 spec.env 控制，与 tmux server/global env 隔离。

### 5. claude.js launch() 重写

新流程:

```
1. buildInstructionFile()
2. 检测 auth 方式（逻辑不变）
3. 判断 tmux session 是否已存在
   - 已存在 → sendMessage(claudeCmd)  // 与当前行为一致
   - 不存在（新建 session，走 launcher）:
     a. 构建 env（clean 或 compat 模式）
        - clean: loadRuntimeEnvManifest() → buildCleanEnv({ manifest })
        - compat: buildCompatEnv()
     b. 注入 auth tokens 到 env
     c. 剥离 ENV_VARS_TO_STRIP (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT)
     d. writeLaunchSpec({ command, args, env, cwd })
     e. execFileSync('tmux', ['new-session', '-d', '-E', '-s', SESSION,
          '-e', 'PATH=...', '-e', 'HOME=...', '-e', 'TERM=...',
          '--', `node ${launcherPath} ${specPath}`])
```

关键变化：
- **删除** shell source 临时文件机制
- **删除** `ENV_CLEAN_PREFIX`——变量直接从 spec.env 中排除
- **保留** 已存在 session 的 sendMessage 路径
- tmux `-e` 参数只传最小集合（PATH, HOME, TERM），确保 launcher 自身能启动
- 添加 `-E` flag 防止 tmux server 环境泄漏

### 6. codex.js launch() 重写

与 claude.js 类似：

```
1. buildInstructionFile()
2. 构建 bootstrap prompt（逻辑不变）
3. 判断 tmux session 是否已存在
   - 已存在 → sendMessage(带 bootstrap prompt 的完整 codex 命令)
   - 不存在（新建 session，走 launcher）:
     a. 构建 env（clean 或 compat 模式，同 claude.js）
     b. 将 bootstrap prompt 写入 spec.args
     c. writeLaunchSpec({ command, args, env, cwd })
     d. execFileSync('tmux', ['new-session', '-d', '-E', ...])
```

关键差异：
- **Codex auth 不注入 env**——Codex CLI 从 `~/.codex/auth.json` 读取凭据
- Bootstrap prompt 作为命令行参数传入 spec.args
- Existing session 保留 bootstrap prompt 语义

### 7. 已存在 session 的处理

当 `_tmuxHasSession()` 返回 true 时，直接通过 `sendMessage()` 注入 CLI 命令，**不走 launcher，不重建 env**。HeartbeatEngine 的 stop+launch 流程会先 kill session 再重建，所以 restart 场景总是走新建分支。

---

## 配置变量

写在 `~/zylos/.env` 中（legacy keys，与 manifest 共存）：

```bash
# 启用干净环境模式（默认 false，兼容模式）
ZYLOS_CLEAN_ENV=false

# 从 .env 文件读值注入到 tmux session 的变量列表
ZYLOS_TMUX_ENV=CLAUDE_CODE_ENABLE_TELEMETRY,OTEL_METRICS_EXPORTER,...

# 从 AM process.env 继承到 tmux session 的变量列表
ZYLOS_TMUX_INHERIT=SSH_AUTH_SOCK

# PATH 扩展（仅 clean env）
ZYLOS_TMUX_PATH_PREPEND=/opt/custom/bin
ZYLOS_TMUX_PATH_APPEND=/opt/extra/tools/bin
```

推荐使用 `$ZYLOS_DIR/.zylos/runtime-env.manifest` 管理（line-based 格式，更清晰）。.env keys 仍然工作，manifest 条目在合并去重时优先。

---

## 测试验证

### 单元测试

| 文件 | 测试数 | 通过 | 运行命令 |
|------|--------|------|----------|
| `tmux-env.test.js` | 54 | 54/54 | `node --test cli/lib/__tests__/tmux-env.test.js` |
| `tmux-launcher.test.js` | — | pass | `node --test cli/lib/__tests__/tmux-launcher.test.js` |
| `runtime-launch.test.js` | — | pass | `node --experimental-test-module-mocks --test cli/lib/__tests__/runtime-launch.test.js` |

**全量 Node 测试**: `npm run test:node -- runtime-launch` → 499/499 pass

#### tmux-env.test.js 覆盖场景

| 模块 | 场景 |
|------|------|
| parseManifest | 逗号分隔解析、空格/空串跳过、无效变量名跳过 + warning |
| parsePathManifest | 绝对路径解析、相对路径跳过 + warning、空值安全 |
| parseRuntimeEnvManifest | 四种 directive 解析、注释/空行、各类 warning（无效名/相对路径/unknown directive/missing arg/too many tokens）、空内容 |
| loadRuntimeEnvManifest | 从 .zylos/ 加载解析、文件缺失返回空 |
| deployManifestTemplate | **缺失时创建**、**存在时不覆盖**、模板缺失安全返回 |
| buildCleanEnv | 8 个基础变量、ambient 隔离、ENV 注入、INHERIT 注入、ENV>INHERIT 冲突、proxy 自动继承、macOS TMPDIR、无效名跳过、IS_SANDBOX（继承/uid=0/非 root）、nvm 路径提取、darwin Homebrew paths、non-darwin 不含 Homebrew、GH_PROMPT_DISABLED、PREPEND/APPEND 顺序、相对路径跳过、空 manifest 安全、PREPEND dedupe、manifest env/inherit/path 注入、manifest + .env 合并去重、manifest env > inherit、backward compat（无 manifest） |
| buildCompatEnv | processEnv 透传、manifest 变量覆盖、PATH dedupe、不注入 GH_PROMPT_DISABLED/Homebrew/PATH manifest |
| writeLaunchSpec / readAndDeleteSpec | 0600 权限写入、读取后删除 |

#### runtime-launch.test.js 覆盖场景

| 模块 | 场景 |
|------|------|
| Claude new session | tmux cmdline 包含 `-E` flag、cmdline 不含 API key、spec.env 排除 CLAUDECODE/CLAUDE_CODE_ENTRYPOINT、native auth 时 spec.env 排除 auth tokens |
| Claude existing session | 不创建新 tmux session、通过 sendMessage 发送命令 |
| Claude compat PATH | spec.env.PATH 在 compat 模式下 deduplicated |
| Codex new session | tmux cmdline 包含 `-E` flag、cmdline 不含 secrets |
| Codex existing session | 不创建新 tmux session、sendMessage 保留 bootstrap prompt |

### 实机验证（已完成）

| 环境 | 验证结果 |
|------|----------|
| macOS H1 (Jinglever) | Clean env 下 Claude + Codex 正常启动。Homebrew PATH 修复后 gh 正常工作。SSH publickey 问题独立于 PATH。 |
| Linux zylos01 | Clean env 下所有工具正常（gh/git/ssh/curl/docker 均在 /usr/bin）。Proxy vars 自动继承验证通过。 |

---

## 迁移策略

1. 默认 `ZYLOS_CLEAN_ENV=false`——升级后行为不变（环境变量完整传入），内部管道从 shell source 切换到 launcher
2. 升级时自动部署 `runtime-env.manifest`（从模板复制，仅缺失时，不覆盖）
3. 在 zylos01 上 opt-in `ZYLOS_CLEAN_ENV=true`，执行验证
4. 验证通过后逐步推广

## 回滚方案

如果 launcher 出现问题，将 zylos-core 回退到上一版本即可恢复旧 shell source 机制。PM2 restart 后立即生效。

---

## 不在本 PR 范围内

- 改变 checkAuth() 逻辑
- 改变 HeartbeatEngine / ContextMonitor
- 改变 session-handoff
- 改变 instruction-builder
- 默认开启 ZYLOS_CLEAN_ENV=true（需要实机验证后再改默认值）
