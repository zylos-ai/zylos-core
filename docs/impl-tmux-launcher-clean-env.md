# 实施文档：tmux-launcher 干净环境方案

**PR branch**: `feat/tmux-launcher-clean-env`
**方案文档**: https://zylos01.jinglever.com/pages/proposal-clean-env-v2
**环境概念**: https://zylos01.jinglever.com/pages/env-concepts-tmux-session
**日期**: 2026-05-09

---

## 目标

一步到位将 tmux session 启动从「shell source 机制」迁移到「launcher 管道」，实现 Level 1 环境变量 allowlisting。launcher 是唯一路径，没有 if/else 分支。

## 变更概览

### 新增文件

| 文件 | 职责 |
|------|------|
| `cli/lib/runtime/tmux-env.js` | 环境构建核心：`buildCleanEnv()`、`buildCompatEnv()`、`parseManifest()`、`writeLaunchSpec()`、`readAndDeleteSpec()` |
| `cli/lib/runtime/tmux-launcher.js` | CLI 入口：`node tmux-launcher.js <spec.json>`，读取 spec、删除文件、spawn child、透传 exit code |
| `cli/lib/__tests__/tmux-env.test.js` | tmux-env.js 单元测试 |
| `cli/lib/__tests__/tmux-launcher.test.js` | tmux-launcher.js 单元测试 |

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `cli/lib/runtime/claude.js` | `launch()` 方法重写——所有模式走 launcher 管道，删除 shell source 机制 |
| `cli/lib/runtime/codex.js` | `launch()` 方法重写——所有模式走 launcher 管道 |

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

```javascript
// 导出的函数签名

/**
 * 构建干净环境对象（ZYLOS_CLEAN_ENV=true）。
 * 从零开始，只包含显式声明的变量。
 */
export function buildCleanEnv({ processEnv, dotenvVars, platform })
// → 返回 { env: Object, warnings: string[] }

/**
 * 构建兼容环境对象（ZYLOS_CLEAN_ENV=false，默认）。
 * 传入完整 processEnv，加上 manifest 变量覆盖。
 */
export function buildCompatEnv({ processEnv, dotenvVars })
// → 返回 { env: Object }

/**
 * 解析 ZYLOS_TMUX_ENV / ZYLOS_TMUX_INHERIT manifest 变量列表。
 * 校验变量名合法性 (/^[A-Za-z_][A-Za-z0-9_]*$/)，跳过非法名。
 */
export function parseManifest(manifestStr)
// → 返回 string[]

/**
 * 将 launch spec 写入临时 JSON 文件（mode 0o600）。
 * spec 包含 { command, args, env, cwd }。
 */
export function writeLaunchSpec(spec)
// → 返回 specPath (string)

/**
 * 读取并立即删除 spec 文件（unlink-before-spawn 安全模式）。
 */
export function readAndDeleteSpec(specPath)
// → 返回 spec object
```

#### buildCleanEnv 逻辑

```
1. 基础集合（硬编码）:
   PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TERM, SHELL

2. 平台特定:
   - macOS (darwin): TMPDIR（从 processEnv 继承，若存在）

3. 自动继承（从 processEnv，无需用户声明）:
   - proxy: HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy, https_proxy, no_proxy
   - 沙箱: IS_SANDBOX（当 uid=0）

4. ZYLOS_TMUX_ENV manifest（从 dotenvVars 读值）:
   - 解析 dotenvVars.ZYLOS_TMUX_ENV 变量列表
   - 从 dotenvVars 中读取每个变量的值

5. ZYLOS_TMUX_INHERIT manifest（从 processEnv 读值）:
   - 解析 dotenvVars.ZYLOS_TMUX_INHERIT 变量列表
   - 从 processEnv 中读取每个变量的值

6. 冲突规则: ZYLOS_TMUX_ENV 优先于 ZYLOS_TMUX_INHERIT

7. Auth tokens（从 dotenvVars 或 processEnv）:
   - 由调用方（claude.js / codex.js）在拿到 env 后单独注入
   - tmux-env.js 不处理 auth
```

#### PATH 构建

```javascript
// 去重 + 确保关键路径存在
const basePaths = [
  path.join(home, '.local', 'bin'),
  path.join(home, '.claude', 'bin'),
  // nvm path (从 processEnv.PATH 中提取 .nvm 段)
  '/usr/local/sbin', '/usr/local/bin',
  '/usr/sbin', '/usr/bin',
  '/sbin', '/bin'
];
// 合并 processEnv.PATH 中的 .nvm 路径段（动态检测）
// 去重后 join(':')
```

### 2. tmux-launcher.js

最小化 CLI 入口，只做四件事：

```javascript
#!/usr/bin/env node
// 1. 读取 argv[2] 指定的 spec.json
// 2. 删除 spec 文件
// 3. spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: 'inherit' })
// 4. child.on('exit', (code, signal) => {
//      // 写 exit log
//      process.exit(signal ? 128 : (code ?? 1));
//    })
```

信号透传：SIGTERM / SIGINT → child.kill(signal)

### 3. claude.js launch() 重写

当前 launch() 的逻辑：

```
旧流程:
  1. buildInstructionFile()
  2. 检测 auth 方式
  3. 判断 tmux session 是否已存在
     - 已存在 → sendMessage(cmd)
     - 不存在 → execFileSync('tmux', [..., shellCmd])
  4. shellCmd 中包含 shell source 机制（写 tmpEnv 文件、source、rm）
```

新流程:

```
新流程:
  1. buildInstructionFile()
  2. 检测 auth 方式（逻辑不变）
  3. 判断 tmux session 是否已存在
     - 已存在 → sendMessage(claudeCmd)  // 只发 claude 命令本身
     - 不存在:
       a. 构建 env（clean 或 compat 模式）
       b. 注入 auth tokens 到 env
       c. 剥离 ENV_VARS_TO_STRIP
       d. writeLaunchSpec({ command, args, env, cwd })
       e. execFileSync('tmux', ['new-session', '-d', '-s', SESSION,
            '-e', 'PATH=...', '-e', 'HOME=...', '-e', 'TERM=...',
            '--', `node ${launcherPath} ${specPath}`])
```

关键变化：
- **删除** shell source 临时文件机制（`set -a; . tmpEnv; set +a; rm -f tmpEnv`）
- **删除** `ENV_CLEAN_PREFIX`（`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT`）——这些变量直接从 spec.env 中排除
- **保留** 已存在 session 的 sendMessage 路径（这条路径不走 launcher，因为 tmux session 已经有环境了）
- tmux `-e` 参数只传最小集合（PATH, HOME, TERM），确保 launcher 自身能启动（node 在 PATH 中）。launcher spawn 的 child 用 spec.env，与 tmux session env 无关。

### 4. codex.js launch() 重写

与 claude.js 类似：

```
新流程:
  1. buildInstructionFile()
  2. 构建 bootstrap prompt（逻辑不变）
  3. 判断 tmux session 是否已存在
     - 已存在 → sendMessage(codexCmd)
     - 不存在:
       a. 构建 env（clean 或 compat 模式）
       b. 注入 codex auth（从 ~/.codex/auth.json 读取并放入 env）
       c. writeLaunchSpec({ command, args, env, cwd })
       d. execFileSync('tmux', [..., `node ${launcherPath} ${specPath}`])
  4. startup dialog check（setTimeout 逻辑不变）
```

关键差异：
- Codex 的 auth 在 `~/.codex/auth.json`，由 Codex CLI 自己读取，不需要注入 env
- Codex 的 bootstrap prompt 作为命令行参数传入，写在 spec.args 中
- OPENAI_API_KEY 等 Codex 相关 key 走 auth.json，不走 env 注入

### 5. 已存在 session 的处理

当 `_tmuxHasSession()` 返回 true 时，说明 tmux session 已经在跑（可能是空 shell 等待命令）。这条路径直接通过 `sendMessage()` 注入 CLI 命令，不走 launcher。

原因：已存在的 session 已经有自己的环境，重新构建 env 需要杀掉 session 再重建——这不是 restart 场景该做的事。当前 HeartbeatEngine 的 stop+launch 流程会先 kill session 再重建，所以 restart 场景总是走「不存在 session」的分支。

---

## 配置变量

写在 `~/zylos/.env` 中：

```bash
# 启用干净环境模式（默认 false，兼容模式）
ZYLOS_CLEAN_ENV=false

# 从 .env 文件读值注入到 tmux session 的变量列表
ZYLOS_TMUX_ENV=CLAUDE_CODE_ENABLE_TELEMETRY,OTEL_METRICS_EXPORTER,...

# 从 AM process.env 继承到 tmux session 的变量列表
ZYLOS_TMUX_INHERIT=SSH_AUTH_SOCK
```

---

## 测试计划

### 单元测试 (tmux-env.test.js)

| # | 场景 | 验证点 |
|---|------|--------|
| 1 | clean env 基础集合 | PATH/HOME/USER/LOGNAME/LANG/LC_ALL/TERM/SHELL 都存在于输出 env |
| 2 | ambient 变量隔离 | 随机 ambient 变量（如 AWS_SECRET_KEY）不出现在 clean env 输出 |
| 3 | ZYLOS_TMUX_ENV 注入 | manifest 列出的变量从 dotenvVars 读值并出现在 env |
| 4 | ZYLOS_TMUX_INHERIT 注入 | manifest 列出的变量从 processEnv 读值并出现在 env |
| 5 | 冲突优先级 | 同名变量同时在 ENV 和 INHERIT 中，ENV（.env）优先 |
| 6 | 无效变量名跳过 | 不符合 `/^[A-Za-z_][A-Za-z0-9_]*$/` 的名字被跳过，warnings 中记录 |
| 7 | proxy 自动继承 | processEnv 中的 HTTP_PROXY 自动出现在 clean env |
| 8 | macOS TMPDIR | platform='darwin' 时 TMPDIR 从 processEnv 继承 |
| 9 | compat 模式 | ZYLOS_CLEAN_ENV=false 时 processEnv 完整传入，manifest 变量覆盖 |
| 10 | spec 文件 I/O | writeLaunchSpec 写入 0o600 文件，readAndDeleteSpec 读取后文件不存在 |
| 11 | parseManifest | 解析逗号分隔列表，去空格，去空串 |

### 单元测试 (tmux-launcher.test.js)

| # | 场景 | 验证点 |
|---|------|--------|
| 12 | 正常退出 | child exit code 0 → launcher exit code 0 |
| 13 | 错误退出 | child exit code 1 → launcher exit code 1 |
| 14 | spec 文件删除 | spawn 之前 spec 文件已被 unlink |

### 实机验证（PR merge 后在 zylos01 上执行）

| # | 场景 | 步骤 | 通过标准 |
|---|------|------|----------|
| E1 | 兼容模式启动 | 设 ZYLOS_CLEAN_ENV=false，升级 zylos-core，PM2 restart | Claude 正常启动、接消息、工具调用、退出 |
| E2 | 干净模式启动 | 设 ZYLOS_CLEAN_ENV=true，restart | 同上 |
| E3 | OTel 数据流 | 干净模式 + ZYLOS_TMUX_ENV 包含 OTel 变量 | otlp-receiver 收到数据 |
| E4 | proxy 场景 | 干净模式，不声明 proxy 在 INHERIT 中 | Claude 自动获取 proxy，API 连通 |
| E5 | 工具链验证 | 干净模式下执行 pm2/git/docker/node/npm | 全部正常 |
| E6 | Codex 启动 | 切换到 codex runtime，验证 launcher 流程 | Codex 正常启动和响应 |

---

## 迁移策略

1. 默认 `ZYLOS_CLEAN_ENV=false`——升级后行为不变（环境变量完整传入），只是内部管道从 shell source 切换到 launcher
2. 在 zylos01 上 opt-in `ZYLOS_CLEAN_ENV=true`，执行 E2-E5 验证
3. 验证通过后逐步推广

## 回滚方案

如果 launcher 出现问题，将 zylos-core 回退到上一版本（`npm install zylos-core@0.4.13`）即可恢复旧 shell source 机制。PM2 restart 后立即生效。

---

## 不在本 PR 范围内

- 改变 checkAuth() 逻辑
- 改变 HeartbeatEngine / ContextMonitor
- 改变 session-handoff
- 改变 instruction-builder
- 默认开启 ZYLOS_CLEAN_ENV=true（需要实机验证后再改默认值）
