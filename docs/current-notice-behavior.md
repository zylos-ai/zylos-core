# Zylos 故障消息提示：当前实现说明

本文说明 PR835 修复后的行为，尚未合并部署。正文列出触发条件、状态变化、收件会话及配置；附录由同一版本的文案渲染代码生成，展示完整默认中英文消息。

## 本轮修复

- 额度错误先检查有效的五小时/七天窗口，再用报错文本细化。即使文本为 `Rate limit exceeded`，可靠窗口已满仍进入额度提示，不再被文本排除规则提前跳过。
- 已识别的文案编号只使用同编号覆盖，不再回退到其他类别的覆盖，避免通用限流文案把带时间提示替换掉。
- 恢复认证失败、模型不可用、计费错误、服务异常及未知失败的首次回复。单次失败回复和持续健康状态仍分开判断。
- 时间显示可配置时区，默认运行机器时区，显示明确时区名称；无效配置回退UTC。

## 谁收到消息

首次失败提示：从失败事件到达前、同一运行时代次/会话/进程内的投递记录中，选择最后一条实际投递消息，使用其原始 `channel` 和 `endpoint`。不是取任意最新入站记录，也不取尚未投递的pending消息。多条消息共享一个prompt时，这是一项“最后投递目标”的策略，不宣称因果上唯一归属于某条请求。

若最新候选仍在确认投递，冻结这一候选并等待最多60秒；不改选后来的消息或较早的消息。确认失败、结果不明或超时则放弃本次首次提示。

后续入站提示：使用这条新消息自己的channel和endpoint。群、话题及私聊地址保留。所有人使用同一套文案，不识别Owner，不另发Owner私聊，不跨渠道广播，不发送恢复通知，不自动重放旧任务。

## 首次失败：触发和状态

以下均要求有效StopFailure事件通过来源、会话、进程和时效校验，且存在可回复目标。旧事件、重复事件以及恢复后无法确定先后顺序的事件，不直接触发新提示。是否实际发送还受共享冷却和发送状态限制。

| Hook错误/证据 | 文案选择 | 对持续状态的影响 |
| --- | --- | --- |
| rate_limit，有效窗口100%且满额窗口都有可靠未来时间 | quota_exhausted_reset | rate_limited |
| rate_limit，有效窗口100%但时间不完整 | quota_exhausted | rate_limited |
| rate_limit，窗口不足以分类，但匹配明确额度/模型/付费额度规则 | 对应额度编号，见下表 | rate_limited |
| rate_limit，无可靠额度证据，或文字只是临时限制/预警/其他诊断 | rate_limited中性提示，不声称额度用尽 | rate_limited |
| billing_error，有可靠满额窗口或明确额度报错 | 对应额度编号 | 本次Hook不直接设为持续限流，保留原健康策略 |
| billing_error，无额度证明 | billing_error，不猜余额、欠费原因 | 保留原健康策略 |
| authentication_failed | auth_failed | 直接切到auth_failed，不等待屏幕检测 |
| model_not_found | model_unavailable | 保留原健康策略 |
| overloaded / server_error | service_error | 保留原健康策略 |
| 其他合法但未识别的错误类型 | unavailable通用失败 | 保留原健康策略 |

“保留原健康策略”不是强制设置正常：原来存在的有效阻塞不会被这条事件清除，后续屏幕检测及受控恢复流程仍可判断持续不可用。

## 额度匹配规则

仅rate_limit/billing_error进入额度分类。额度快照必须来自当前运行时、会话和进程，在Hook采集时不超过60秒；快照随失败事件保存，后来的数据不能改写旧失败的含义。不会把文件更新时间当成来源证明。

对于仍在持续的Hook限流状态，后来到达的状态栏快照可作为独立的“当前故障额度信息”补充通知。它必须与原失败的运行时代次、会话、PID及进程启动标识完全一致，采集时间不早于失败、接纳时不超过60秒。历史事件和原始分类不变，健康状态、恢复判定、健康修订号、目标和冷却也不变。

首次通知的独立发送进程最多等待750毫秒再读一次快照；超出等待窗口就用原提示。后续入站路由和状态发布也会读取快照，因此首次仍为通用提示时，后续可带上恢复时间。已接纳的信息按当前故障单独保存，监控重启后仍可用；已过期的恢复时间不再显示，较新的有效快照会替换旧信息，即使新快照已不满额。快照本身不触发恢复、不补发历史通知，也不绕过同话题600秒冷却。若两个窗口都满额，只在两个恢复时间都有效时显示较晚者。

1. 先看可信额度窗口。达到100%才算已满；无数据或低于100%不能据此推断“模型额度用尽”。
2. 两窗口都满且都有可靠时间时取较晚时间；任一满额窗口缺时间，不报时间。
3. 窗口不能分类时，再看Hook报错文本。只在内存匹配，保存规则编号和类别，不保存或发送原文。优先error_details，缺失时用last_assistant_message；超长或不匹配时降级。
4. 发送时重置时间已过期，带时间提示降为不带时间提示。到点不自动清除受限，不承诺一定恢复。

| 文案编号 | 文本细化条件（只有未命中可信窗口时才用） |
| --- | --- |
| quota_exhausted | 明确组织、个人、渠道、团队预算上限；session/weekly上限；通用usage limit已到达 |
| quota_exhausted_reset | 不从文本解析日期；只来自已验证窗口 |
| model_quota_exhausted | Fable额度上限、Fable上限后未回答的确认结果、明确Opus/Sonnet专属limit |
| usage_credits_required | 模型requires usage credits；now uses usage credits且确认无人回答 |
| usage_credits_exhausted | 明确out of usage credits |
| quota_allocation_unavailable | 席位不含用量、额度分配被停用、组限额设为$0 |

Opus/Sonnet规则依据参考表中“专属额度”分支，不把模型名称本身作为证据。与可信五小时/七天满额窗口同时出现时，窗口仍优先。尚未以真实账号故意耗尽额度验证该产品场景。

## 33类参考如何使用

33是诊断规则编号数量，不是33条独立通知，更不是33个新状态。它们不恢复旧方案的Owner分流、付费弹窗交互、自动重启或“已经通知管理员”等行为。

| 来源编号 | 识别内容 | 当前作用 |
| --- | --- | --- |
| 1、2 | Fable上限；上限后未回答确认 | 模型额度细化；2必须有未回答结果 |
| 3 | 包含用量用完的付款弹窗 | 不仅凭弹窗触发；保留Hook错误基础提示 |
| 4、5 | 需要付费额度、上限/余额变体、未回答确认 | 按具体变体选择额度文案；不推断一律模型额度耗尽 |
| 6、7、8、9 | 组织、个人、渠道、团队上限 | 总额度细化，不猜Fable模型 |
| 10 | 付费额度/组织用量 | 明确付费额度才细化；组织add funds不套订阅额度 |
| 11 | session、weekly、Opus、Sonnet上限 | session/weekly总额度；Opus/Sonnet专属模型额度 |
| 12 | 接近上限或百分比预警 | 无满额证明不宣称耗尽；单独预警不触发Hook失败通知 |
| 13 | 席位、分配、$0限额 | 明确分配不可用细化 |
| 14、15 | API余额、长上下文付费要求 | 不直接推断订阅额度；使用结构化错误基础提示 |
| 16–21 | 登录、认证、策略、凭据 | 依据Hook错误类型回复；不凭文字推断token被撤销 |
| 22–24 | 模型访问、套餐、模型策略 | model_not_found用模型不可用；其他仍按Hook类型 |
| 25–27 | 临时请求限制、过载、网络错误 | 无满额窗口时不宣称耗尽；已有可信满额窗口时不能阻止基础额度提示 |
| 28–33 | 上下文、请求大小、图片、PDF、工具记录、过滤 | 不新增专属操作/自动修复；有效StopFailure按结构化类型或通用失败回复 |

## 后续消息与恢复

| 当前状态 | 新消息怎么处理 |
| --- | --- |
| ok | 正常进入队列，不发程序故障提示；不受之前提示冷却阻拦 |
| rate_limited | 按已有策略决定是否检查恢复；仍受限则发当前额度/中性限流提示，消息不进入处理队列 |
| auth_failed | 按认证恢复策略检查；仍失败则发认证不可用提示，不入队 |
| unavailable及对应旧状态 | 按受控恢复检查及退避处理；仍不可用则发通用不可用提示，不入队 |

非额度单次失败没有改变持续状态时，下一条消息可正常投递；不是收到过一次服务端错误后就一直拒绝新消息。

## Hook与屏幕冲突

- 当前运行时已有有效Stop正常证据，并且状态正常：屏幕识别限流只记录，不转状态。
- 当前有效Hook失败证据存在时，无明确轮次归属的屏幕结果不能覆盖它。
- 还没有有效Hook正常/失败证据时，原屏幕兜底仍参与判断。没有StopFailure本身不是“正常证据”，也不会把正常状态改成异常。
- Stop不会单独清除已有故障。恢复由AM的可用性检查裁决，额度时间、进程存活或屏幕错误消失都不是单独恢复凭据。
- 已确认恢复后遇到无法判断先后的失败事件，先核验；不让迟到结果直接回滚恢复。

## 不发送的情况

- 没有有效StopFailure，仅在用户正文或屏幕看到报错文字，不走新增的首次失败通知。
- 旧运行时/会话、过期、损坏、重复、来源不明、缺prompt或恢复后顺序不明的事件。
- 找不到合格的实际投递目标；最新候选确认失败、超时或结果不明；不回复控制消息及无回复地址消息。
- 同会话/话题在10分钟成功发送冷却内，或已有发送占位。
- 同一故障周期已有发送结果不明记录，避免重复发送；明确新的故障周期才可重新尝试。
- no-reply入站不发提示。已恢复时，后续入站正常排队，不发入站故障提示或恢复广播。

已经持久登记但尚未发送的首次失败提示，在同一运行时会话恢复后仍可能发送，内容描述那次已发生的失败。当前发送端检查目标、运行时和冷却，不因当前状态恢复就取消该历史失败提示；运行时代次或会话已切换则不发送。

提示发送成功才开始600秒冷却；限流、认证及其他原因共享会话冷却。不同thread/root仍是不同话题。确定未发送不占成功冷却，后续新消息或新失败可重新尝试；当前首次提示意图不自动重试。开始发送后的超时/崩溃可能已经送达，标记结果不明，不盲目重发。外部渠道发送与本地数据库不能原子提交，不承诺绝对不漏不重。

## 配置覆盖

`statusNotices`配置以平台部署方式提供。修改后按正常流程重启读取配置的相关进程；本次未修改任何线上配置。

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

`failure`是首次失败，`inbound`是后续入站。每个编号分别提供zh/en，未配的语言使用默认。覆盖的是完整消息正文：不会额外拼接默认后缀，但品牌前缀仍添加。始终中文在前、英文在后，不判断发送人身份或语言。

具体编号不会借用其他类别覆盖。例如配置rate_limited不会覆盖quota_exhausted_reset。过期时间降级到quota_exhausted后使用该编号的配置。`{resetAt}`只在有效带时间编号中替换，其他模板不能凭配置生成恢复时间。品牌最多80字符，单种语言正文最多2000字符；无效值使用默认。timeZone可使用IANA时区，未配置取运行机器时区，无效值回退UTC，消息始终标注时区。

## 范围和验证边界

Core实现负责Hook、AM、C4和消息配置。ops-agent采集上报及dashboard展示不属于本任务。没有合并、安装或部署本次改动。

已做隔离状态栏进程、额度快照、Hook采集、SQLite事务、通知处理、并发冷却和崩溃恢复验证。真实订阅耗尽到真实渠道的完整验收尚未进行，按Owner结论不作为本次阻塞。Hook原文只在内存匹配，记录保存脱敏字段；这不是原文日志归档方案。

## 完整默认消息附录

以下内容由当前文案渲染函数直接生成。时间示例为生成时刻后一小时，时区示例Asia/Shanghai，不代表真实故障。平台配置覆盖后以配置为准。

### model_unavailable

**首次失败**

```text
[Zylos] 当前模型不可用，请检查模型配置或切换模型后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The current model is unavailable. Please check the model configuration or switch models, then try again. This request could not be completed. Please resend it later.
```

**入站格式示例（当前流程不会仅因该单次错误选用此入站文案）**

```text
[Zylos] 当前模型不可用，请检查模型配置或切换模型后重试。本条消息已收到，但未进入处理队列。
[Zylos] The current model is unavailable. Please check the model configuration or switch models, then try again. Your message was received but was not added to the processing queue.
```

### billing_error

**首次失败**

```text
[Zylos] 服务返回了计费错误，请联系该 Agent 的负责人检查账户计费状态后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported a billing error. Please contact the Agent owner to check the account billing status, then try again. This request could not be completed. Please resend it later.
```

**入站格式示例（当前流程不会仅因该单次错误选用此入站文案）**

```text
[Zylos] 服务返回了计费错误，请联系该 Agent 的负责人检查账户计费状态后重试。本条消息已收到，但未进入处理队列。
[Zylos] The service reported a billing error. Please contact the Agent owner to check the account billing status, then try again. Your message was received but was not added to the processing queue.
```

### service_error

**首次失败**

```text
[Zylos] 服务返回了服务端错误或过载，请稍后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported a server error or overload. Please try again later. This request could not be completed. Please resend it later.
```

**入站格式示例（当前流程不会仅因该单次错误选用此入站文案）**

```text
[Zylos] 服务返回了服务端错误或过载，请稍后重试。本条消息已收到，但未进入处理队列。
[Zylos] The service reported a server error or overload. Please try again later. Your message was received but was not added to the processing queue.
```

### quota_exhausted

**首次失败**

```text
[Zylos] 该 Agent 的使用额度已用完，请稍后重试；如需帮助，请联系该 Agent 的负责人。本次请求未能完成，请稍后重新发送。
[Zylos] This Agent has exhausted its usage quota. Please try again later, or contact the Agent owner for help. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 该 Agent 的使用额度已用完，请稍后重试；如需帮助，请联系该 Agent 的负责人。本条消息已收到，但未进入处理队列。
[Zylos] This Agent has exhausted its usage quota. Please try again later, or contact the Agent owner for help. Your message was received but was not added to the processing queue.
```

### quota_exhausted_reset

**首次失败**

```text
[Zylos] 该 Agent 的使用额度已用完，预计于 2026-10-21 18:00 Asia/Shanghai 重置。请在该时间之后重试。本次请求未能完成，请稍后重新发送。
[Zylos] This Agent has exhausted its usage quota. The quota is expected to reset at 2026-10-21 18:00 Asia/Shanghai. Please try again after that time. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 该 Agent 的使用额度已用完，预计于 2026-10-21 18:00 Asia/Shanghai 重置。请在该时间之后重试。本条消息已收到，但未进入处理队列。
[Zylos] This Agent has exhausted its usage quota. The quota is expected to reset at 2026-10-21 18:00 Asia/Shanghai. Please try again after that time. Your message was received but was not added to the processing queue.
```

### model_quota_exhausted

**首次失败**

```text
[Zylos] 当前模型的可用额度已用完，请联系该 Agent 的负责人切换模型后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The current model has no available quota. Please contact the Agent owner to switch models, then try again. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 当前模型的可用额度已用完，请联系该 Agent 的负责人切换模型后重试。本条消息已收到，但未进入处理队列。
[Zylos] The current model has no available quota. Please contact the Agent owner to switch models, then try again. Your message was received but was not added to the processing queue.
```

### usage_credits_required

**首次失败**

```text
[Zylos] 当前模型需要付费使用额度，请联系该 Agent 的负责人确认额度或切换模型后重试。本次请求未能完成，请稍后重新发送。
[Zylos] The current model requires paid usage credits. Please contact the Agent owner to check the available credits or switch models, then try again. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 当前模型需要付费使用额度，请联系该 Agent 的负责人确认额度或切换模型后重试。本条消息已收到，但未进入处理队列。
[Zylos] The current model requires paid usage credits. Please contact the Agent owner to check the available credits or switch models, then try again. Your message was received but was not added to the processing queue.
```

### quota_allocation_unavailable

**首次失败**

```text
[Zylos] 该 Agent 当前没有可用的额度分配，请联系该 Agent 的负责人检查配置后重试。本次请求未能完成，请稍后重新发送。
[Zylos] This Agent currently has no available quota allocation. Please contact the Agent owner to check the configuration, then try again. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 该 Agent 当前没有可用的额度分配，请联系该 Agent 的负责人检查配置后重试。本条消息已收到，但未进入处理队列。
[Zylos] This Agent currently has no available quota allocation. Please contact the Agent owner to check the configuration, then try again. Your message was received but was not added to the processing queue.
```

### usage_credits_exhausted

**首次失败**

```text
[Zylos] 该 Agent 的付费使用额度已用完，请联系该 Agent 的负责人检查额度或切换模型后重试。本次请求未能完成，请稍后重新发送。
[Zylos] This Agent has exhausted its paid usage credits. Please contact the Agent owner to check the credits or switch models, then try again. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 该 Agent 的付费使用额度已用完，请联系该 Agent 的负责人检查额度或切换模型后重试。本条消息已收到，但未进入处理队列。
[Zylos] This Agent has exhausted its paid usage credits. Please contact the Agent owner to check the credits or switch models, then try again. Your message was received but was not added to the processing queue.
```

### rate_limited

**首次失败**

```text
[Zylos] 服务返回了限流错误。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported a rate limit for this request. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 当前服务暂时受限，请稍后重试。本条消息已收到，但未进入处理队列。
[Zylos] The service is currently rate-limited. Please try again later. Your message was received but was not added to the processing queue.
```

### auth_failed

**首次失败**

```text
[Zylos] 服务返回了认证错误。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported an authentication error for this request. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 当前认证不可用，恢复访问后才能继续处理，请稍后重试。本条消息已收到，但未进入处理队列。
[Zylos] Authentication is currently unavailable. Please try again after access is restored. Your message was received but was not added to the processing queue.
```

### unavailable

**首次失败**

```text
[Zylos] 服务返回了请求失败。本次请求未能完成，请稍后重新发送。
[Zylos] The service reported a failure for this request. This request could not be completed. Please resend it later.
```

**后续入站（仅当持续状态仍受限时）**

```text
[Zylos] 当前服务暂时不可用，请稍后重试。本条消息已收到，但未进入处理队列。
[Zylos] The service is temporarily unavailable. Please try again later. Your message was received but was not added to the processing queue.
```
