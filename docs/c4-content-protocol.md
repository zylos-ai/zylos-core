# C4 content protocol

Version 1. This is a C4 transport adapter, not the full ChatWeave streaming/message protocol. Definition and fixtures require Luna's acceptance before downstream use. Authority: `zylos-internal-docs` main `ed9c041` — `core/session-architecture/implementation-plan-p14-dashboard-chat.md` v0.3.1 and `core/session-architecture/dashboard-chat.md` v0.1.6 §3 (both at that SHA). Core baseline `6436b3e255d108f097d3863d43f88a2fc140d4dc`. ChatWeave semantics are pinned to [`03e69a4435ce2f4913ed28884509f3db64d6ebcf`](https://github.com/zz-howard/chatweave/tree/03e69a4435ce2f4913ed28884509f3db64d6ebcf), `docs/protocol.md` §§3, 4.8, 5 and its `schemas/v0.1/` definitions.

## Framing and limits

The exact first line is `[C4-CONTENT]` followed by LF. Prefix bytes in hex: `5b 43 34 2d 43 4f 4e 54 45 4e 54 5d 0a`. No BOM, leading spaces, CRLF variant, code fence or search inside the content. Without that exact prefix, content is ordinary text, including ordinary JSON. The prefix is followed by one complete JSON **object**. Standard JSON whitespace is allowed before/after that object. A string/escape-aware depth scan finds its end; never use the last `}`. JSON syntax still goes through JSON.parse.

After JSON, only JSON whitespace or exactly one existing Core suffix is accepted:

```text
\n\n[C4] Status notification suppressed by cooldown while health=<health> reason=<reason>.
```

Here `\n` denotes LF bytes, not backslash characters. `health` and `reason` are nonempty strings containing no LF; spaces are allowed. The complete template is anchored at the end of content (apart from JSON whitespace), with its final period belonging to the template. Their values are diagnostic text, not a finite enum or guaranteed token. No extra prose, second JSON, repeated suffix or prefix-matching approximation is accepted. Source: `skills/comm-bridge/scripts/c4-store-delivery.js`, `markStatusNoticeSuppressed`. The writer defaults missing health to `unavailable` and missing reason to health; it appends only to eligible failed inbound records. Parsing ignores this annotation, preserving original C4 identity and `metadata.zylos.answerId`. It neither changes storage nor claims the notification was delivered.

Marked content, including prefix/JSON/any suffix, has a maximum of **65,536 UTF-8 bytes**, inclusive. Count bytes, not UTF-16 units or characters. The parser returns unmarked ordinary text unchanged regardless of its length, preserving existing history from every channel. The Dashboard channel BeforeSend hook separately enforces a 65,536-byte sending cap on both ordinary and structured content before storage; this is a sending rule, not a general history-reading cap. No truncation of structured content. Images/large data use existing references, not inline binaries.

`parseC4Content(content)` returns `{kind:'text',text}`, `{kind:'envelope',envelope,suffix}` or `{kind:'invalid',reason}`. Invalid tagged content never becomes ordinary text; invalid results do not carry raw payload. Consumers provide their existing readable error/C4 reference and no actions. Unsupported versions/types are invalid for this adapter and therefore read-only fallback/error, never an invitation to fetch remote code.

## Parse result reason categories

These fixed functional values are part of the common parser contract. Classification checks content type, then prefix. Unmarked content returns text immediately; only marked content is checked for byte limit, framing/JSON syntax, suffix and envelope schema. A marked non-object is invalid_json; unmarked JSON is text.

| reason | Meaning |
| --- | --- |
| `content_type` | Input is not a string. |
| `content_too_large` | Marked UTF-8 content exceeds 65,536 bytes. Unmarked text is never invalidated by this reading limit. |
| `invalid_json` | Marked body is not one complete syntactically valid JSON object. |
| `invalid_suffix` | The complete object has neither JSON whitespace nor the exact known suffix after it. |
| `invalid_envelope` | Parsed object has unsupported version/type, missing/invalid fields or inconsistent question/answer references. |

Invalid fixtures state expected reason explicitly; replacing one category with another must fail a test. These are parse categories, not new hook machine reason codes.

## Envelope fields

All fields below are case-sensitive. Unknown envelope fields are rejected. IDs follow ChatWeave message/interrupt IDs: `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`. Block IDs follow `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Action IDs use the former alphabet with length 8–128. IDs are opaque; schema does not allocate them or confer permissions.

| Field | Requirement / meaning |
| --- | --- |
| `version` | Required integer `1`; independent of upstream `protocolVersion:'0.1'`. |
| `kind` | Required `message`, `answer` or `control`. |
| `messageId` | Required ID for this immutable display/transport message; not a C4 row ID or hook correlation ID. |
| `fallbackText` | Required nonempty plain readable text, max 16,000 Unicode code points. Contains no host secrets; renderer must treat text as text. Question includes question plus waiting prompt. |
| `blocks` | Required on `message`, 0–64 ordered blocks; absent on `answer`/`control`. Unique block IDs. |
| `interruptId` | For a question: ID of the one open question; for answer/control: original question ID. Required on answer/control. |
| `questionSummary` | Required on questions and answers, nonempty max 500 code points. Generated/persisted as below; answer reads it from saved question, never trusts a client's replacement summary. |
| `interrupt` | Question only: `{blockId,reason,otherInput?}`. `reason` = `confirmation` for confirmation, otherwise `input_required`; `otherInput` boolean defaults true. Must reference an open interactive block. Present together with `interruptId` and `questionSummary`, or all absent. No runtime step/stream state is invented. |
| `action` | Answer only: original ChatWeave ActionRequest (below). |
| `metadata` | Message: optional opaque object, maximum depth 6 including the metadata root (same counting as block data); deeper values are invalid_envelope. Answer: exactly `{zylos:{answerId}}`, where answerId equals `action.id`. Not rendered/projected. Control: absent. |
| `control` | Control only: explicit host lifecycle record described below. |

C4 row ID locates authoritative storage; messageId locates a display message; interruptId locates a question; action.id/answerId identifies one accepted user intent. The fixed answer ID path is **`metadata.zylos.answerId`**. Reconciliation parses the envelope at this path after scoping rows by original group, channel and inbound direction, never full-text contains. No new C4 columns.

### Question summary generation

`makeQuestionSummary(envelope)` finds `interrupt.blockId`. Use the first nonempty text from that block's `fallbackText`, `data.prompt`, `data.title`, `data.purpose`, then the envelope `fallbackText`. Normalize consecutive Unicode whitespace to one ASCII space, trim, take the first 500 Unicode code points. The declared questionSummary must equal that generated result. Save it with the question and its constraints only **after** the authoritative C4 row is verified. The summary is not a reconstruction from the current agent context.

Answer fallbackText is generated by the host as `回答了 interruptId=<id>（问题：<questionSummary>）：<readable answer>`. The readable answer uses saved option labels, confirm/cancel words, saved field labels/values or literal freeText. It must represent the accepted payload. The parser validates structure; permission, pending-state, summary provenance and this readable rendering are checked against the saved question by the answering host. Core projection only reads fallbackText and safe references.

## Blocks: six presentation classes, upstream shapes

Blocks keep ChatWeave's `{id,type,schemaVersion:1,data,fallbackText?,metadata?,status?,reason?}` shape and limits. Non-markdown needs fallbackText (max 2,000 code points). Status omitted means complete; pending/error follow upstream schema, but cannot be used to create an open question without complete valid question data. `reason` only on error. No arbitrary HTML execution, JavaScript callbacks, colors/layout recipes or invented action types.

| Presentation | Upstream type / principal data and constraints |
| --- | --- |
| Text | `markdown`: `{text}` (max 32,768 code points and 32,768 UTF-8 bytes, subject to whole-content byte cap). |
| Chart | `time_series`: `{xType,series,title?,xLabel?,yLabel?,yUnit?,format?,summary?}`, xType date/datetime/number/category, 1–6 series `{key,label,points,unit?}`, up to 500 `{x,y}` points; x string≤64 or number, y finite number/null. Also existing `breakdown` (2–12 nonnegative parts) and `category_series` (1–24 points, finite number/null) keep their upstream schemas. No synthetic `chart` type. |
| Single choice | `choice`: `{prompt,options,selection?,minSelect?,maxSelect?,allowFreeText?,action,state?}`, default selection single; options 2–10 `{id,label,description?}`; selected payload exactly one known option. |
| Multiple choice | Same `choice`, `selection:'multiple'`; selected IDs unique, 1–10 overall and within saved minSelect/maxSelect (defaults 1/options.length). |
| Confirmation | `confirmation`: `{title,severity,action,body?,details?,confirmLabel?,cancelLabel?,state?}`; severity normal/destructive. requiresConfirmation=true only on destructive confirmation. |
| Form | `form_intent`: `{fields,action,title?,purpose?,submitLabel?,state?}`; 1–12 fields. Field key `[a-z][a-z0-9_]{0,31}`, label, type and optional required/options/min/max/maxLength/unit/placeholder/help/defaultValue. Types text, multiline_text, number, integer, date, datetime, boolean, single_select, multi_select. Select fields need declared options; submitted values must meet saved fields, types, bounds and membership, with no unknown keys. |

Block data also retains upstream depth ≤6 (data root =1) and per-block 5,000 JSON-node limits.

The table selects a supported host subset; it does not rename or redefine the complete upstream block catalogue. Other upstream or future blocks are read-only fallback/error in this version. Detailed per-field limits and interaction-state shapes are the pinned upstream schema; the shared validator embeds the selected definitions so Node and browser use one contract, without runtime network/dependency loading.

Interaction states retain upstream semantics: open (default), resolved, expired, cancelled, superseded. Resolved has exactly the suitable selected/outcome/values/freeText plus resolvedAt; cancelled requires a reason; superseded requires supersededBy. Server-ended states carry no user resolvedBy. Confirmation **cancel is a resolved answer**, not the cancelled state. These states describe saved display data, not Core execution gating. C4 does not patch old question rows; Dashboard overlays current question state.

## Actions, answers and lifecycle controls

Only three upstream block actions: `choice.select`, `confirmation.respond`, `form.submit`. ActionSpec is `{type,target,requiresConfirmation?,expiresAt?}`; target matches `[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}`, ≤64 chars. It names an existing registered handler; this module never runs it or creates a new business handler.

ActionRequest is `{id,protocolVersion:'0.1',type,target,context,payload,clientTs?}`; context contains required messageId/blockId and optional conversationId. User/permissions/tenant are host-derived. `validateAnswer(action,questionEnvelope)` checks the saved type, target, context, open interrupt and payload. It does not authorize a user or perform conditional persistence.

| Type | Exactly one payload form |
| --- | --- |
| choice.select | `{selected:[known option IDs]}` or `{freeText}` |
| confirmation.respond | `{outcome:'confirm'|'cancel'}` or `{freeText}` |
| form.submit | `{values:{saved field key:value}}` or `{freeText}` |

freeText is nonempty, max 500 code points, only on an open interrupt whose otherInput is not false. It is an answer, not a new chat message and is never interpreted as an option by schema. No new ID on timeout/retry; reuse the same action.id. Idempotent acceptance and concurrency remain Dashboard responsibilities.

Explicit `control` is **host lifecycle metadata**, not another ChatWeave ActionSpec:

- Stop: `{operation:'stop',messageId:<question display ID>}` with top interruptId. Closes that question; never fabricates `{outcome:'cancel'}` and does not stop the whole runtime.
- Replace: `{operation:'replace',messageId:<old question display ID>,replacementInterruptId:<new question ID>}` with top interruptId identifying the old question. New question must be separately registered and authorized by the host. No text guessing, automatic replacement by ordinary messages or implicit replacement on page close.

These serialize the existing upstream stopped/superseded lifecycle meanings for host persistence. They do not add a fourth block action, execute generation endpoints or implement state transitions here.

## BeforeSend wire

A channel's own SKILL.md frontmatter declares:

```yaml
c4:
  before_send:
    hook_id: dashboard.content
    entry: scripts/before-send.js
    timeout_ms: 1500
  delivery: stdin
```

The number is an example, not a Core default or cap. Required timeout_ms is a finite positive number set by the component. Only one synchronous script BeforeSend; no HTTP, async, BeforeReceive, registry service or ordering chain. Hook declaration validation/execution belongs to the hook implementation. entry is relative to this channel skill directory and must resolve within that directory; an escaping path is an invalid declaration. Execute `spawn('node',[absoluteEntry])`, without a shell, with cwd equal to that skill directory; entry is the only argv argument to node (no content in argv).

stdout has a 1 MiB cap. On overflow Core terminates the child and reports HOOK_INVALID_OUTPUT; simultaneous overflow/timeout reports HOOK_TIMEOUT. A signal Core sends for timeout/overflow is that cause, not an independent HOOK_EXEC_FAILED signal exit. stderr is not part of the wire; drain and discard it.

Input is exactly one JSON object on stdin:

```json
{"version":1,"hook_event_name":"BeforeSend","hook_id":"dashboard.content","request_id":"core-generated","invocation_id":"core-generated","request":{"channel":"dashboard","endpoint":"conversation_a","content":"original content","options":{"groupName":"conversation_a"}},"context":{"component":"dashboard","session_group":"dashboard:conversation_a","runtime":"codex"}}
```

Required top fields are those shown, including context (may be `{}`). request requires channel (nonempty string), endpoint (string/null), content (string), options (object: optional groupName string/wholeGroup boolean). Context allows optional nonempty component/session_group/runtime/session_id/run_id only; omit unavailable identifiers. Core creates correlation IDs; caller cannot override them. No new c4_id before storage; do not write a head/namespace to fill context.

Output: `{version:1,decision:'continue'}` or `{version:1,decision:'abort',message:<string>}`. No content rewrite or extra fields; continue must contain only version and decision; a message on continue is invalid. `validateHookInput`/`validateHookOutput` validate shapes only. `normalizeHookMessage(message)` replaces line breaks (CR/LF/U+2028/U+2029) with spaces, then takes first **500 Unicode code points**. This normalization does not change the machine reason code.

Core mapping is fixed: normal abort → HOOK_ABORTED; invalid declaration/output, async or unsupported event → HOOK_INVALID_OUTPUT; spawn/nonzero/signal → HOOK_EXEC_FAILED, even if stdout looks valid; timeout → HOOK_TIMEOUT takes priority. Only normal exit continue permits the original send. Failure format includes one stderr line `HOOK_ABORTED <normalized message>` for abort plus machine reason/message. This module runs no hooks, scripts, state reads or writes.

## Post-storage stdin delivery

```json
{"version":1,"c4_id":123,"channel":"dashboard","endpoint_id":"conversation_a","session_group":"dashboard:conversation_a","content":"original content"}
```

All six fields are required; no extras. c4_id is a positive safe integer or canonical positive decimal string up to SQLite signed 64-bit max. The channel reads the authoritative row by c4_id and verifies id, channel, endpoint_id (string/null), session_group and original content **exactly** before registration. `validateDeliveryPacket(packet,row)` is a pure comparison; no C4 connection, lookup, mutation or question registration. A mismatch in any field returns false. Compare the raw stored content including any known suffix; do not compare a reserialized or projected value. No row means no registration. Existing channels' argv delivery is untouched by this module.

## Browser delivery and consumers

`skills/comm-bridge/scripts/c4-content-schema.js` is one ESM file with **zero imports**, using only standard JavaScript/Web globals. Node and browser import these same bytes. Public exact alias `/_assets/chat-schema.js` maps only this file; it does not expose the scripts directory. The client adapter at `/_assets/js/wb/chat-blocks.js` imports `../../chat-schema.js`, so root, base and fleet prefixes stay local and are not doubled. A missing source file fails rather than using a copied schema.

Fleet pages use the local Dashboard's schema source, not the remote instance's code. Version mismatch degrades to existing readable fallback/error without actions. Do not fetch remote schema or execute remote components.

Consumers share parse results: hook rejects invalid tagged content; projection emits only fallback and safe references; registration/reconciliation use validated IDs and the authoritative row; rendering supplies fallback/error and no actions for invalid/unsupported content. Projection, persistence, access control, runtime hooks, migrations and UI rendering are separate tasks. This definition does not activate structured production.

Fixture contract: `test/fixtures/c4-content-protocol.json` contains literal valid/invalid content, action/payload checks, wire and delivery examples. Boundary-sized Unicode cases are generated in tests to keep the fixture reviewable. Tests directly import the module; no source evaluation, patching, or test-generated negative mutation.
