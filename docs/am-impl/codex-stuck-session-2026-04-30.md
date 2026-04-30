# Codex Stuck Session Investigation: 2026-04-30

> 状态：Investigation note
> 相关 proposal：[deferred-codex-tool-call-watchdog.md](deferred-codex-tool-call-watchdog.md)
> 结论：本次 13 小时卡住更像 Codex unified exec/tool runner 的 completion wait 问题，不是 Activity Monitor、C4、Lark 或系统资源耗尽直接导致。

## 1. 背景

2026-04-30，Codex runtime 出现一个长时间 `Working` session，Activity Monitor 一直看到 runtime busy，直到用户手动中断后 Codex 退出并被 Guardian 重启。

目标 session/thread：

```text
019dda43-b0a2-71d2-a441-597007915d59
```

目标 rollout：

```text
~/.codex/sessions/2026/04/30/rollout-2026-04-30T01-22-42-019dda43-b0a2-71d2-a441-597007915d59.jsonl
```

用户请求是 session bootstrap。Codex 在同一轮里并行发起了三个 `exec_command`：

1. `session-start-inject.js`
2. `c4-session-init.js`
3. `session-start-prompt.js`

## 2. Timeline

关键时间均为 Codex 日志中的 UTC 时间。

| Time | Event |
|------|-------|
| `2026-04-29T17:22:48Z` | 用户 turn 开始，bootstrap prompt 进入 Codex |
| `2026-04-29T17:22:56.051Z` | `session-start-inject.js` `exec_command` 发起 |
| `2026-04-29T17:22:56.057Z` | `c4-session-init.js` `exec_command` 发起 |
| `2026-04-29T17:22:56.117Z` | `session-start-prompt.js` `exec_command` 发起 |
| `2026-04-29T17:22:56.423Z` | `c4-session-init.js` `exec_command_end` |
| `2026-04-29T17:22:56.812Z` | `session-start-prompt.js` `exec_command_end` |
| `2026-04-30T06:29:26.116Z` | `session-start-inject.js` 返回 `aborted by user after 47190.1s` |
| `2026-04-30T06:29:26.127Z` | `c4-session-init.js` 的 `function_call_output` 才交给模型 |
| `2026-04-30T06:29:26.130Z` | `session-start-prompt.js` 的 `function_call_output` 才交给模型 |
| `2026-04-30T06:29:26Z` | turn 被 abort |
| `2026-04-30T06:29:47Z` | Codex session 关闭 |

rollout 里最大的 event gap 是：

```text
47189.304s
event_msg/exec_command_end -> response_item/function_call_output
```

## 3. Evidence

### 3.1 Rollout JSONL

rollout 证明：

- 三个 exec tool calls 几乎同时发起。
- 后两个 shell command 很快结束。
- 后两个 `function_call_output` 没有马上返回给模型，而是在卡住的 `session-start-inject.js` 被用户 abort 后才一起出现。

这说明 Codex 当时不是在继续推理，而是在等待并行 tool calls 的 completion 汇合。

### 3.2 codex-tui.log

`codex-tui.log` 对同一 thread 的记录显示：

```text
codex_core::tasks: close time.busy=180ms time.idle=47198s
session handlers closed time.idle=47198s
```

这支持两个判断：

- 模型没有持续采样 13 小时。
- 主要时间消耗在 runtime/tool wait 状态。

### 3.3 hook-timing.log

同一启动窗口里只有：

```text
hook=c4-session-init duration=22ms
hook=session-start-prompt duration=215ms
```

没有 `session-start-inject` 的 timing 记录。

`session-start-inject.js` 正常会在 `finally` 里写 timing。因此缺失 timing 支持这个判断：卡住的那次 invocation 没有完成脚本的正常 finally path。

这仍然不能证明 Node 脚本内部一定没有启动。可能卡在：

- child process launch 之前或 launch 阶段
- exec runner 等待 stdout/stderr/EOF
- completion event 从 runner 回 Codex 时丢失
- 脚本内部某个极早期路径

### 3.4 Activity Monitor Logs

Activity Monitor 在目标窗口看到：

```text
17:22:48 BUSY
06:29:35 IDLE
06:29:48 OFFLINE
06:29:52 Guardian: Starting Codex...
```

这说明 AM 正常观察到了 Codex 长时间 busy，用户 abort 后 Codex 退出，Guardian 随后重启 runtime。

### 3.5 System Logs

检查过的系统信号：

- `journalctl`
- `/var/log/syslog`
- `/var/log/kern.log`
- `sar` CPU/memory/IO
- Codex `logs_2.sqlite`
- Codex `state_5.sqlite`

没有发现与该窗口吻合的 OOM、segfault、Node crash、主机 CPU/IO/memory exhaustion。

`logs_2.sqlite` 只保留了中断后的采样/重试/关闭信息，未保留 17:22 原始启动阶段日志。

## 4. Conclusion

本次 stuck point 更准确的描述是：

```text
Codex unified exec/tool runner waited for one parallel exec completion for ~13h.
```

已有日志不能把根因坐实为 `session-start-inject.js` 脚本逻辑，也不能坐实为 C4、Lark、Activity Monitor 或系统资源问题。

可能性排序：

1. Codex unified exec 并行状态/汇合等待 bug。
2. stdio/EOF/PTY completion event 丢失。
3. child launch 阶段卡住。
4. `session-start-inject.js` 内部真实挂住，概率较低。

## 5. AM Implications

这次事故暴露的是 AM 现有边界之外的 live-but-stuck 状态：

- runtime 进程还活着
- tmux session 存在
- Codex UI 显示 `Working`
- 主 loop 因 tool wait 无法处理后续用户消息
- Activity Monitor 的 Guardian 不会把这类状态当作 process down

短期工程防护应优先放在两个位置：

1. bootstrap 侧：避免并行 startup execs，给每个 bootstrap step 加外层 timeout 和 trace marker。
2. AM 侧：增加 “长时间 busy 且 rollout 无进展” 的 best-effort stuck detector。

第二项已经在 deferred proposal 中记录为未来方向，当前 AM v3 主线不直接实现。

## 6. Recommended Follow-ups

### 6.1 Bootstrap Hardening

建议把 Codex bootstrap 改成串行流程，且每一步都有明确 timeout：

```text
session-start-inject.js -> c4-session-init.js -> session-start-prompt.js
```

每步至少写入：

- start marker
- end marker
- exit code
- duration
- timeout marker

这样未来能区分：

- 脚本未启动
- 脚本启动但未进入 main
- 脚本进入 main 但未进入 finally
- 脚本完成但 Codex tool runner 未交付 output

### 6.2 AM Stuck Detector

未来实现应参考：

```text
docs/am-impl/deferred-codex-tool-call-watchdog.md
```

建议保持 deferred 状态，等 AM v3 主线组件拆分完成后再实现。

### 6.3 Logging Gap

本次 `hook-timing.log` 只能证明 hook 成功完成时的 duration，不能证明 process spawn 之前/之后的边界。

未来应考虑在 wrapper 层写 trace，而不是只在 hook script 自己的 `finally` 中写 timing。

## 7. Current Status

本文件是调查记录，不改变 AM v3 当前实施范围。

当前 AM v3 implementation 仍按 `docs/am-impl/README.md` 的实施顺序推进。Codex stuck-session watchdog 暂不进入本轮 implementation scope。
