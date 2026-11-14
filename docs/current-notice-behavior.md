# Zylos Failure Notices: Current Implementation

This document describes the target behavior of PR835 after its scope was narrowed during review; it has not yet been merged or deployed. The body covers triggers, state changes, recipient conversations, and configuration; the appendix shows the default Chinese and English messages.

## Fixes in This Revision

- Quota errors first check valid five-hour/seven-day windows, then refine the notice using error text. Even when the text is `Rate limit exceeded`, a reliable full window still selects a quota notice instead of being skipped early by text exclusion rules.
- A recognized message ID uses only its own override, without falling back to another category's override, so a generic rate-limit message cannot replace a notice containing a reset time.
- Restore first-failure replies for authentication failures, unavailable models, billing errors, service errors, and unknown failures. Single-failure replies and persistent health state are still evaluated separately.
- Display times in a configurable time zone, defaulting to the runtime machine's zone, with an explicit zone name; invalid configuration falls back to UTC.

## Who Receives Notices

First-failure notices: as required by review, freeze the most recent inbound message with status `running` or `delivered` and a reply address when the failure is received, retaining its original `channel` and `endpoint`. No delivery table is added. This strategy does not prove a unique causal relationship between one prompt and one message, nor guarantee that a running message has completed submission.

Messages rejected while unhealthy are recorded as failed, including cooldown-suppressed and no-reply cases; the dispatcher's markDelivered consistently writes delivered. Sending does not switch to a newer target.

Subsequent inbound notices use the new message's own channel and endpoint, preserving group, topic, and private-chat addresses. Everyone receives the same wording. There is no Owner detection, separate Owner DM, cross-channel broadcast, recovery notice, or automatic replay of old tasks.

## First Failure: Triggers and State

All cases below require a valid StopFailure event that passes source, session, process, and freshness checks, plus a target that can receive a reply. Old or duplicate events, and events no later than confirmed recovery, do not trigger new notices; after recovery, a valid failure in the next turn of the same process and session can re-enter failure state. Actual sending is also constrained by cooldown and send state.

| Hook error/evidence | Message selection | Effect on persistent state |
| --- | --- | --- |
| rate_limit, valid window at 100% and every full window has a reliable future time | quota_exhausted_reset | rate_limited |
| rate_limit, valid window at 100% but incomplete times | quota_exhausted | rate_limited |
| rate_limit, windows cannot classify it but an explicit quota/model/paid-credit rule matches | Corresponding quota ID; see below | rate_limited |
| rate_limit, no reliable quota evidence, or text indicates only a temporary limit/warning/other diagnostic | Neutral rate_limited notice; do not claim quota exhaustion | rate_limited |
| billing_error, reliable full window or explicit quota error | Corresponding quota ID | This Hook does not directly set persistent rate limiting; retain the existing health policy |
| billing_error, no quota evidence | billing_error; do not guess balances or reasons for unpaid charges | Retain the existing health policy |
| authentication_failed | auth_failed | Switch directly to auth_failed without waiting for screen detection |
| model_not_found | model_unavailable | Retain the existing health policy |
| overloaded / server_error | service_error | Retain the existing health policy |
| Other valid but unrecognized error types | Generic unavailable failure | Retain the existing health policy |

"Retain the existing health policy" does not force a healthy state: this event does not clear an existing valid block, and subsequent screen detection and controlled recovery may still determine persistent unavailability.

## Quota Matching Rules

Only rate_limit/billing_error enter quota classification. A quota snapshot must come from the current session and managed process and be no more than 60 seconds old when accepted; later data does not rewrite original failure evidence. A separate late-arriving quota supplement may be saved for the same valid rate-limit failure to update first and subsequent notices; the first send waits at most 750 milliseconds. File modification time is not treated as proof of provenance.

For a persistent Hook rate-limit state, a later statusline snapshot may supplement notices as separate "quota information for the current failure." Its session and managed PID must exactly match the original failure, its collection time must not precede the failure, and it must be no more than 60 seconds old when accepted. Historical events and original classification remain unchanged, as do health state, recovery decisions, health revision, target, and cooldown.

Before the first notice, wait nonblockingly for at most 750 milliseconds and read the snapshot again; after that window, use the original notice. Actual channel sending runs in a child process. Subsequent inbound routing and state publication also read the snapshot, so later notices can include a reset time even if the first notice was generic. Accepted information is saved separately for the current failure and remains available after monitor restarts; expired reset times are no longer displayed, and a newer valid snapshot replaces older information even if it is no longer full. A snapshot itself neither triggers recovery nor resends historical notices, and does not bypass the 600-second cooldown for the same channel, topic, and health/reason. If both windows are full, show the later reset time only when both times are valid.

1. Check trusted quota windows first. Only 100% counts as full; missing data or a value below 100% cannot establish model quota exhaustion.
2. If both windows are full and have reliable times, use the later time; if any full window lacks a time, report no time.
3. If windows cannot classify the failure, inspect Hook error text. Match only in memory, storing the rule ID and category without saving or sending raw text. Prefer error_details, falling back to last_assistant_message when absent; downgrade when text is too long or does not match.
4. If the reset time has expired by send time, downgrade the timed notice to one without a time. Reaching that time does not automatically clear rate limiting or promise recovery.

| Message ID | Text refinement conditions (used only when no trusted window matches) |
| --- | --- |
| quota_exhausted | Explicit organization, personal, channel, or team budget cap; session/weekly cap; generic usage limit reached |
| quota_exhausted_reset | Never parse dates from text; use verified windows only |
| model_quota_exhausted | Fable quota cap, an unanswered confirmation result after the Fable cap, or an explicit Opus/Sonnet-specific limit |
| usage_credits_required | Model requires usage credits; now uses usage credits with confirmation that nobody answered |
| usage_credits_exhausted | Explicit out of usage credits |
| quota_allocation_unavailable | Seat includes no usage, quota allocation disabled, or group limit set to $0 |

Opus/Sonnet rules follow the reference table's dedicated-quota branch; model names alone are not evidence. Trusted full five-hour/seven-day windows still take priority when both appear. This product scenario has not been verified by deliberately exhausting a real account's quota.

## How to Use the 33 Reference Categories

33 is the number of diagnostic rule IDs, not 33 independent notices or 33 new states. They do not restore the old design's Owner routing, payment-dialog interactions, automatic restarts, or claims that an administrator has been notified.

| Source IDs | Recognized content | Current role |
| --- | --- | --- |
| 1,2 | Fable cap; unanswered confirmation after the cap | Refine model quota; 2 requires an unanswered result |
| 3 | Payment dialog stating included usage is exhausted | Do not trigger on the dialog alone; retain the basic Hook error notice |
| 4,5 | Paid credits required, cap/balance variants, unanswered confirmation | Select quota wording by the specific variant; do not infer model quota exhaustion for every case |
| 6,7,8,9 | Organization, personal, channel, team caps | Refine overall quota without guessing the Fable model |
| 10 | Paid credits/organization usage | Refine only explicit paid-credit evidence; do not treat organization add funds as subscription quota |
| 11 | session, weekly, Opus, Sonnet caps | session/weekly overall quota; Opus/Sonnet-specific model quota |
| 12 | Near-cap or percentage warnings | Do not claim exhaustion without proof of a full window; a warning alone does not trigger a Hook failure notice |
| 13 | Seats, allocation, $0 limit | Refine explicit allocation unavailability |
| 14,15 | API balance, paid long-context requirements | Do not directly infer subscription quota; use the basic structured-error notice |
| 16–21 | Login, authentication, policy, credentials | Reply by Hook error type; do not infer token revocation from text |
| 22–24 | Model access, plan, model policy | Use model unavailable for model_not_found; otherwise follow the Hook type |
| 25–27 | Temporary request limits, overload, network errors | Do not claim exhaustion without a full window; trusted full windows must not be blocked from selecting a basic quota notice |
| 28–33 | Context, request size, images, PDF, tool records, filtering | Add no dedicated operations/automatic repairs; reply to valid StopFailure with the structured type or generic failure |

## Subsequent Messages and Recovery

| Current state | Handling of new messages |
| --- | --- |
| ok | Queue normally without a program-failure notice; previous notice cooldown does not block delivery |
| rate_limited | Use the existing policy to decide whether to check recovery; if still limited, send the current quota/neutral rate-limit notice without queuing the message |
| auth_failed | Check under the authentication recovery policy; if still failing, send an authentication-unavailable notice without queuing |
| unavailable and corresponding legacy states | Apply controlled recovery checks and backoff; if still unavailable, send a generic unavailable notice without queuing |

If a single non-quota failure did not change persistent state, the next message can be delivered normally; one server error does not cause indefinite rejection of new messages.

## Conflicts Between Hooks and Screen Detection

- When the current runtime has valid healthy Stop evidence and is healthy, screen-detected rate limiting is recorded without changing state.
- When valid current Hook failure evidence exists, screen results without explicit turn attribution cannot override it.
- Before valid healthy/failure Hook evidence exists, the original screen fallback still contributes to decisions. The absence of StopFailure is not itself healthy evidence and does not turn a healthy state into an unhealthy one.
- Stop alone does not clear an existing failure. AM availability checks decide recovery; quota times, process liveness, or disappearance of a screen error are not sufficient recovery evidence on their own.
- In synchronous Hook time order, reject failure events no later than confirmed recovery; process new failures strictly after recovery normally. A retained recovered or old prompt marker must not cause later failures to be ignored permanently.

## When Notices Are Not Sent

- Without valid StopFailure, error text seen only in user content or on screen does not enter the new first-failure notice path.
- Events from old runtimes/sessions, expired, corrupt, duplicate, unattributed, missing a prompt, or no later than confirmed recovery.
- No eligible actual delivery target; the latest candidate is confirmed failed, timed out, or has an unknown result. Do not reply to control messages or messages without reply addresses.
- The same channel, normalized conversation/topic, health, and reason are within the 10-minute cooldown, or a send reservation already exists.
- If the send outcome is unknown, retain the cooldown reservation and do not automatically retry the same first receipt; a new inbound message may prompt another notice after cooldown expires.
- No-reply inbound messages receive no notice. After recovery, subsequent inbound messages queue normally without an inbound failure notice or recovery broadcast.

A first-failure notice that is persisted but not yet sent may still be sent after the same runtime session recovers, describing the failure that already occurred. The current sender checks target, runtime, and cooldown; recovery of the current state does not cancel this historical failure notice. A changed runtime generation or session prevents sending.

After successful notification, retain a 600-second cooldown, counted separately by health/reason; a changed reason can prompt immediately. Different thread/root values remain different topics. A reservation may be released if sending definitely did not start, allowing a later new message to try again; the first notice is not retried automatically. A timeout/crash after sending starts may have delivered the message, so retain the cooldown reservation. Diagnostic logs rotate at 100KB and do not participate in resend decisions; absolute loss-free, duplicate-free delivery is not promised.

## Persistence and Replay

Health state and pending first receipts are stored in the same atomic file for each runtime, with no new C4 table or change to schema1. Health events reuse tool-events.jsonl. Stop/StopFailure process only events whose received_at is strictly later than the last processed time, saving the timestamp and state atomically together; event_id is diagnostic only, with no saved ID set. SessionStart/UserPromptSubmit do not advance this timestamp. Events beyond the 5-minute validity period are still rejected; clock rollback may cause missed notices, an accepted tradeoff in this revision.

Identity uses the Claude PID and session_id from the managed tmux pane, without reading process start time or using a generation file or environment variable. Linux and Mac share the mechanism, with separate underlying parent-process query adapters; health events are not accepted when managed identity cannot be confirmed. If a PID is reused and the same session resumes, old and new processes cannot be distinguished. This is an accepted simplification; event freshness and last-processed time still apply. Hook synchronization runs only during installation/initialization/upgrade sync steps; changing the Claude version separately requires resynchronizing Hooks. Stable versions >=2.1.78 (including 3.x) support the new Hooks.

Instances that installed an earlier schema2 version of this PR require separate upgrade continuation handling; do not directly downgrade the schema or delete tables. This revision did not operate on those instances' data.

## Configuration Overrides

`statusNotices` configuration is supplied through platform deployment. After changes, follow the normal process to restart relevant processes that read it; no live configuration was changed in this revision.

```json
{
  "statusNotices": {
    "brand": "YourProduct",
    "timeZone": "Asia/Shanghai",
    "templates": {
      "failure": {
        "quota_exhausted_reset": {
          "zh": "该 Agent 的额度预计于 {resetAt} 重置，本次请求未完成，请届时重试。",
          "en": "This Agent's quota is expected to reset at {resetAt}. This request did not complete; please retry then."
        },
        "auth_failed": {
          "zh": "本次请求遇到认证错误，请联系支持人员后重试。",
          "en": "This request encountered an authentication error. Please contact support and try again."
        }
      },
      "inbound": {
        "quota_exhausted_reset": {
          "zh": "额度预计于 {resetAt} 重置，本条消息未进入队列，请届时重新发送。",
          "en": "The quota is expected to reset at {resetAt}. This message was not queued; please resend it then."
        }
      }
    }
  }
}
```

`failure` means the first failure; `inbound` means subsequent inbound messages. Each ID provides zh/en separately, using defaults for unconfigured languages. Overrides replace the entire message body: no default suffix is appended, but the brand prefix is still added. Chinese always precedes English, regardless of sender identity or language.

Specific IDs never borrow overrides from other categories. For example, configuring rate_limited does not override quota_exhausted_reset. After an expired time downgrades the notice to quota_exhausted, that ID's configuration applies. `{resetAt}` is replaced only for valid timed IDs; configuration alone cannot make other templates generate recovery times. The brand is limited to 80 characters and each language's body to 2000 characters; invalid values use defaults. timeZone accepts IANA zones, defaults to the runtime machine's zone when unset, and falls back to UTC when invalid. Messages always identify the time zone.

## Scope and Verification Boundaries

The Core implementation covers Hooks, AM, C4, and message configuration. ops-agent collection/reporting and dashboard display are outside this task. These changes have not been merged, installed, or deployed.

Isolated verification has covered statusline processes, quota snapshots, Hook collection, SQLite transactions, notice handling, concurrent cooldown, and crash recovery. Full acceptance from real subscription exhaustion through a real channel has not been performed; per the Owner's decision, it does not block this revision. Raw Hook text is matched only in memory and records store sanitized fields; this is not a raw-log archival design.

## Complete Default Message Appendix

The content below was generated directly by the current message renderer. Example times are one hour after generation, using Asia/Shanghai as the example time zone; they do not represent a real failure. Platform configuration overrides take precedence.

### model_unavailable

**First failure**

```text
[Zylos] 当前模型不可用，请检查模型配置或切换模型后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The current model is unavailable. Please check the model configuration or switch models, then try again. This request could not be completed. Please resend it later.
```

**Inbound format example (the current flow does not select this inbound wording for this single error alone)**

```text
[Zylos] 当前模型不可用，请检查模型配置或切换模型后重试。本条消息已收到，但未进入处理队列。
[Zylos] The current model is unavailable. Please check the model configuration or switch models, then try again. Your message was received but was not added to the processing queue.
```

### billing_error

**First failure**

```text
[Zylos] 服务返回了计费错误，请联系该 Agent 的负责人检查账户计费状态后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported a billing error. Please contact the Agent owner to check the account billing status, then try again. This request could not be completed. Please resend it later.
```

**Inbound format example (the current flow does not select this inbound wording for this single error alone)**

```text
[Zylos] 服务返回了计费错误，请联系该 Agent 的负责人检查账户计费状态后重试。本条消息已收到，但未进入处理队列。
[Zylos] The service reported a billing error. Please contact the Agent owner to check the account billing status, then try again. Your message was received but was not added to the processing queue.
```

### service_error

**First failure**

```text
[Zylos] 服务返回了服务端错误或过载，请稍后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported a server error or overload. Please try again later. This request could not be completed. Please resend it later.
```

**Inbound format example (the current flow does not select this inbound wording for this single error alone)**

```text
[Zylos] 服务返回了服务端错误或过载，请稍后重试。本条消息已收到，但未进入处理队列。
[Zylos] The service reported a server error or overload. Please try again later. Your message was received but was not added to the processing queue.
```

### quota_exhausted

**First failure**

```text
[Zylos] 该 Agent 的使用额度已用完，请稍后重试；如需帮助，请联系该 Agent 的负责人。本次请求未能完成，请稍后重新发送。
[Zylos] This Agent has exhausted its usage quota. Please try again later, or contact the Agent owner for help. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 该 Agent 的使用额度已用完，请稍后重试；如需帮助，请联系该 Agent 的负责人。本条消息已收到，但未进入处理队列。
[Zylos] This Agent has exhausted its usage quota. Please try again later, or contact the Agent owner for help. Your message was received but was not added to the processing queue.
```

### quota_exhausted_reset

**First failure**

```text
[Zylos] 该 Agent 的使用额度已用完，预计于 2026-10-21 18:00 Asia/Shanghai 重置。请在该时间之后重试。本次请求未能完成，请稍后重新发送。
[Zylos] This Agent has exhausted its usage quota. The quota is expected to reset at 2026-10-21 18:00 Asia/Shanghai. Please try again after that time. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 该 Agent 的使用额度已用完，预计于 2026-10-21 18:00 Asia/Shanghai 重置。请在该时间之后重试。本条消息已收到，但未进入处理队列。
[Zylos] This Agent has exhausted its usage quota. The quota is expected to reset at 2026-10-21 18:00 Asia/Shanghai. Please try again after that time. Your message was received but was not added to the processing queue.
```

### model_quota_exhausted

**First failure**

```text
[Zylos] 当前模型的可用额度已用完，请联系该 Agent 的负责人切换模型后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The current model has no available quota. Please contact the Agent owner to switch models, then try again. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 当前模型的可用额度已用完，请联系该 Agent 的负责人切换模型后重试。本条消息已收到，但未进入处理队列。
[Zylos] The current model has no available quota. Please contact the Agent owner to switch models, then try again. Your message was received but was not added to the processing queue.
```

### usage_credits_required

**First failure**

```text
[Zylos] 当前模型需要付费使用额度，请联系该 Agent 的负责人确认额度或切换模型后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The current model requires paid usage credits. Please contact the Agent owner to check the available credits or switch models, then try again. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 当前模型需要付费使用额度，请联系该 Agent 的负责人确认额度或切换模型后重试。本条消息已收到，但未进入处理队列。
[Zylos] The current model requires paid usage credits. Please contact the Agent owner to check the available credits or switch models, then try again. Your message was received but was not added to the processing queue.
```

### quota_allocation_unavailable

**First failure**

```text
[Zylos] 该 Agent 当前没有可用的额度分配，请联系该 Agent 的负责人检查配置后重试。本次请求未能完成，请稍后重新发送。
[Zylos] This Agent currently has no available quota allocation. Please contact the Agent owner to check the configuration, then try again. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 该 Agent 当前没有可用的额度分配，请联系该 Agent 的负责人检查配置后重试。本条消息已收到，但未进入处理队列。
[Zylos] This Agent currently has no available quota allocation. Please contact the Agent owner to check the configuration, then try again. Your message was received but was not added to the processing queue.
```

### usage_credits_exhausted

**First failure**

```text
[Zylos] 该 Agent 的付费使用额度已用完，请联系该 Agent 的负责人检查额度或切换模型后重试。本次请求未能完成，请稍后重新发送。
[Zylos] This Agent has exhausted its paid usage credits. Please contact the Agent owner to check the credits or switch models, then try again. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 该 Agent 的付费使用额度已用完，请联系该 Agent 的负责人检查额度或切换模型后重试。本条消息已收到，但未进入处理队列。
[Zylos] This Agent has exhausted its paid usage credits. Please contact the Agent owner to check the credits or switch models, then try again. Your message was received but was not added to the processing queue.
```

### rate_limited

**First failure**

```text
[Zylos] 服务返回了限流错误。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported a rate limit for this request. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 当前服务暂时受限，请稍后重试。本条消息已收到，但未进入处理队列。
[Zylos] The service is currently rate-limited. Please try again later. Your message was received but was not added to the processing queue.
```

### auth_failed

**First failure**

```text
[Zylos] 服务返回了认证错误。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported an authentication error for this request. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 当前认证不可用，恢复访问后才能继续处理，请稍后重试。本条消息已收到，但未进入处理队列。
[Zylos] Authentication is currently unavailable. Please try again after access is restored. Your message was received but was not added to the processing queue.
```

### unavailable

**First failure**

```text
[Zylos] 服务返回了请求失败。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported a failure for this request. This request could not be completed. Please resend it later.
```

**Subsequent inbound (only while the persistent state remains limited)**

```text
[Zylos] 当前服务暂时不可用，请稍后重试。本条消息已收到，但未进入处理队列。
[Zylos] The service is temporarily unavailable. Please try again later. Your message was received but was not added to the processing queue.
```
