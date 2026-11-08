// Codex multi-agent rollout lines as Codex writes them, with prompts, messages, final texts, accounts and paths
// replaced by "<redacted>" (or "<redacted final text>"); every other field is as recorded.
// - Multi-agent v2: excerpts of a parent rollout from a real Codex 0.166 session (2026-11-01). They come from
//   different turns of that session; tests rebase their times and use them one turn at a time.
// - Multi-agent v1 in code mode: one turn from a real Codex 0.167.0 run in an isolated environment
//   (`--enable multi_agent --disable multi_agent_v2`); the parent's lines and the first lines of the child's own rollout.
// Lines that were not recorded and are built here from a recorded line of the same kind are marked where they are made.

/** v2 parent rollout excerpts: spawn, its SubAgentActivity start and answer; a wait that timed out; two
 * SubAgentActivity completions. */
export const V2_LINES = [
  {"timestamp":"2026-11-01T13:19:19.616Z","ordinal":1039,"type":"response_item","payload":{"type":"function_call","status":"completed","name":"spawn_agent","namespace":"collaboration","arguments":"{\"task_name\": \"zylo131_plan_audit\", \"message\": \"<redacted>\"}","call_id":"call_76894efa3fca4e3aaefb4bb49239c373","internal_chat_message_metadata_passthrough":{"turn_id":"01a19742-d660-73c3-8fd8-c75fca58ccef","create_time":1793539150.122521}},"metadata":{"client_authored":false,"user_input_order":69}},
  {"timestamp":"2026-11-01T13:19:19.773Z","ordinal":1041,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a196ba-3630-7393-91a9-ef9a3cfd8dc9","turn_id":"01a19742-d660-73c3-8fd8-c75fca58ccef","item":{"type":"SubAgentActivity","model":"gpt-6.1-sol","reasoning_effort":"medium","id":"call_76894efa3fca4e3aaefb4bb49239c373","kind":"started","agent_thread_id":"01a19743-b6a4-7fd1-8d67-a19d7b201aa9","agent_path":"/root/zylo131_plan_audit"},"started_at_ms":1793539159773,"completed_at_ms":1793539159773}},
  {"timestamp":"2026-11-01T13:19:19.837Z","ordinal":1042,"type":"response_item","payload":{"type":"function_call_output","call_id":"call_76894efa3fca4e3aaefb4bb49239c373","output":"{\"task_name\": \"/root/zylo131_plan_audit\"}","internal_chat_message_metadata_passthrough":{"turn_id":"01a19742-d660-73c3-8fd8-c75fca58ccef","create_time":1793539159.8376768}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
  {"timestamp":"2026-11-01T13:20:41.847Z","ordinal":1089,"type":"response_item","payload":{"type":"function_call","status":"completed","name":"wait_agent","namespace":"collaboration","arguments":"{\"timeout_ms\": 10000}","call_id":"call_e6928bc31ffe4e3089b4d44e16f0d622","internal_chat_message_metadata_passthrough":{"turn_id":"01a19742-d660-73c3-8fd8-c75fca58ccef","create_time":1793539241.726347}},"metadata":{"client_authored":false,"user_input_order":74}},
  {"timestamp":"2026-11-01T13:20:51.900Z","ordinal":1091,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a196ba-3630-7393-91a9-ef9a3cfd8dc9","turn_id":"01a19742-d660-73c3-8fd8-c75fca58ccef","item":{"type":"CollabAgentToolCall","id":"call_e6928bc31ffe4e3089b4d44e16f0d622","tool":"wait","status":"completed","sender_thread_id":"01a196ba-3630-7393-91a9-ef9a3cfd8dc9","receiver_thread_ids":[],"receiver_agents":[],"agents_states":{}},"started_at_ms":1793539241899,"completed_at_ms":1793539251900}},
  {"timestamp":"2026-11-01T13:20:51.956Z","ordinal":1092,"type":"response_item","payload":{"type":"function_call_output","call_id":"call_e6928bc31ffe4e3089b4d44e16f0d622","output":"{\"message\": \"<redacted>\", \"timed_out\": true}","internal_chat_message_metadata_passthrough":{"turn_id":"01a19742-d660-73c3-8fd8-c75fca58ccef","create_time":1793539251.9562578}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
  {"timestamp":"2026-11-01T12:19:06.426Z","ordinal":350,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a196ba-3630-7393-91a9-ef9a3cfd8dc9","turn_id":"01a1970a-cb21-78a1-866d-6a98458fcb22","item":{"type":"SubAgentActivity","model":null,"reasoning_effort":null,"id":"subagent-completed-01a1970b-40ae-7563-8f99-b19203b5bedc","kind":"completed","agent_thread_id":"01a1970b-4096-7d70-8d18-800aaf683a4e","agent_path":"/root/single_session_priorities"},"started_at_ms":1793535546426,"completed_at_ms":1793535546426}},
  {"timestamp":"2026-11-01T12:25:55.210Z","ordinal":473,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a196ba-3630-7393-91a9-ef9a3cfd8dc9","turn_id":"01a19710-9530-7532-9f5d-858eeb5d7387","item":{"type":"SubAgentActivity","model":null,"reasoning_effort":null,"id":"subagent-completed-01a19711-6a78-7182-8cfc-208f01a020e3","kind":"completed","agent_thread_id":"01a19711-6a58-7ee2-b2dc-7369d672a270","agent_path":"/root/pr937_static"},"started_at_ms":1793535955210,"completed_at_ms":1793535955210}},
];

/** v1 code mode, parent thread: turn start, exec spawn (+ CollabAgentToolCall), exec wait (+ CollabAgentToolCall),
 * the completion notice, turn end. */
export const V1_PARENT_LINES = [
  {"timestamp":"2026-11-08T19:21:35.748Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_attribution":{"turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","turn_trigger":"exec","parent_turn_id":null,"initiating_agent_path":null,"root_turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade"},"turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","root_turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","started_at":1794165695,"model_context_window":258400,"collaboration_mode_kind":"default"}},
  {"timestamp":"2026-11-08T19:21:43.291Z","ordinal":21,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_0636bf21f6aa8cf8016af0cbc68cf487d08675c81df0fdf345","status":"completed","call_id":"call_0016d476f4024c2687513a0705f68c83","name":"exec","input":"const r = await tools.multi_agent_v1__spawn_agent({message:\"<redacted>\"});\ntext(JSON.stringify(r));\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","create_time":1794165702.5525517}}},
  {"timestamp":"2026-11-08T19:21:43.307Z","ordinal":22,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1bc9b-e07d-7840-b13a-26dc16c735b4","turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","item":{"type":"CollabAgentToolCall","id":"exec-26e15b06-e4df-4326-980d-1846ba82527e","tool":"spawn_agent","status":"completed","sender_thread_id":"01a1bc9b-e07d-7840-b13a-26dc16c735b4","receiver_thread_ids":["01a1bc9c-0287-7631-85b4-bf0601a2988e"],"receiver_agents":[{"thread_id":"01a1bc9c-0287-7631-85b4-bf0601a2988e","agent_nickname":"Kierkegaard"}],"prompt":"<redacted>","model":"gpt-5.6-luna","reasoning_effort":"low","agents_states":{"01a1bc9c-0287-7631-85b4-bf0601a2988e":"pending_init"}},"started_at_ms":1794165703302,"completed_at_ms":1794165703307}},
  {"timestamp":"2026-11-08T19:21:43.312Z","ordinal":24,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a1bc9c-0290-7762-9e68-cbe418ac64f0","call_id":"call_0016d476f4024c2687513a0705f68c83","output":[{"type":"input_text","text":"Script completed\nWall time 0.0 seconds\nOutput:\n"},{"type":"input_text","text":"{\"agent_id\":\"01a1bc9c-0287-7631-85b4-bf0601a2988e\",\"nickname\":\"Kierkegaard\"}"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","create_time":1794165703.3124442}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
  {"timestamp":"2026-11-08T19:21:45.033Z","ordinal":27,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_0636bf21f6aa8cf8016af0cbc80e4c87d0855f0270263aa1da","status":"completed","call_id":"call_116fe16cd6fe449c81f99b5d804d5816","name":"exec","input":"const r = await tools.multi_agent_v1__wait_agent({targets:[\"01a1bc9c-0287-7631-85b4-bf0601a2988e\"],timeout_ms:3600000});\ntext(JSON.stringify(r));\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","create_time":1794165704.058874}}},
  {"timestamp":"2026-11-08T19:21:50.465Z","ordinal":29,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a1bc9b-e07d-7840-b13a-26dc16c735b4","turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","item":{"type":"CollabAgentToolCall","id":"exec-0985daae-186b-45d3-9d96-5a56a91fcc57","tool":"wait","status":"completed","sender_thread_id":"01a1bc9b-e07d-7840-b13a-26dc16c735b4","receiver_thread_ids":["01a1bc9c-0287-7631-85b4-bf0601a2988e"],"receiver_agents":[{"thread_id":"01a1bc9c-0287-7631-85b4-bf0601a2988e","agent_nickname":"Kierkegaard"}],"agents_states":{"01a1bc9c-0287-7631-85b4-bf0601a2988e":{"completed":"hi"}}},"started_at_ms":1794165705043,"completed_at_ms":1794165710465}},
  {"timestamp":"2026-11-08T19:21:50.467Z","ordinal":30,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a1bc9c-1e83-7c40-9551-ef2f05238214","call_id":"call_116fe16cd6fe449c81f99b5d804d5816","output":[{"type":"input_text","text":"Script completed\nWall time 5.4 seconds\nOutput:\n"},{"type":"input_text","text":"{\"status\":{\"01a1bc9c-0287-7631-85b4-bf0601a2988e\":{\"completed\":\"hi\"}},\"timed_out\":false}"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","create_time":1794165710.4674184}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
  {"timestamp":"2026-11-08T19:21:50.469Z","ordinal":32,"type":"response_item","payload":{"type":"message","id":"msg_01a1bc9c-1e85-7493-842d-538be1631995","role":"user","content":[{"type":"input_text","text":"<subagent_notification>\n{\"agent_path\":\"01a1bc9c-0287-7631-85b4-bf0601a2988e\",\"status\":{\"completed\":\"hi\"}}\n</subagent_notification>"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","create_time":1794165710.469211,"content_item_kinds":["multi_agent.subagent_notification"],"content_item_metadata":[{"provenance":{"type":"tool","namespace":"multi_agent_v1"}}]}}},
  {"timestamp":"2026-11-08T19:21:51.503Z","ordinal":41,"type":"event_msg","payload":{"type":"task_complete","root_turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","last_agent_message":"done","started_at":1794165695,"completed_at":1794165711,"duration_ms":15757,"time_to_first_token_ms":4812}}
];

/** v1 code mode, the child's own rollout: its session_meta (session_id = the parent thread) and turn start. */
export const V1_CHILD_LINES = [
  {"timestamp":"2026-11-08T19:21:43.307Z","ordinal":0,"type":"session_meta","payload":{"creator_user_id":"<redacted>","creator_account_id":"<redacted>","session_id":"01a1bc9b-e07d-7840-b13a-26dc16c735b4","id":"01a1bc9c-0287-7631-85b4-bf0601a2988e","parent_thread_id":"01a1bc9b-e07d-7840-b13a-26dc16c735b4","timestamp":"2026-11-08T19:21:43.304Z","cwd":"<redacted>","runtime_workspace_roots":["<redacted>"],"originator":"codex_exec","cli_version":"0.167.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":"01a1bc9b-e07d-7840-b13a-26dc16c735b4","depth":1,"agent_path":null,"agent_nickname":"Kierkegaard","agent_role":null}}},"thread_source":"subagent","agent_nickname":"Kierkegaard","model_provider":"openai","base_instructions":"<redacted>","history_mode":"paginated","multi_agent_version":"v1","context_window":{"window_id":"01a1bc9c-0287-7631-85b4-bf1d8bbd8a7f"}}},
  {"timestamp":"2026-11-08T19:21:43.307Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_attribution":{"turn_id":"01a1bc9c-0289-7d12-9e8e-8db3456415ae","turn_trigger":"exec","parent_turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","initiating_agent_path":null,"root_turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade"},"turn_id":"01a1bc9c-0289-7d12-9e8e-8db3456415ae","root_turn_id":"01a1bc9b-e500-7690-bff8-c9d3b3307ade","started_at":1794165703,"model_context_window":258400,"collaboration_mode_kind":"default"}}
];

const clone = value => JSON.parse(JSON.stringify(value));
const v2 = predicate => clone(V2_LINES.find(predicate));
const V2_SPAWN_CALL = 'call_76894efa3fca4e3aaefb4bb49239c373';
const V2_WAIT_CALL = 'call_e6928bc31ffe4e3089b4d44e16f0d622';
export const V2_TASK = '/root/zylo131_plan_audit';
export const V1_CHILD = '01a1bc9c-0287-7631-85b4-bf0601a2988e';
export const V1_SPAWN_EXEC = 'call_0016d476f4024c2687513a0705f68c83';
export const V1_WAIT_EXEC = 'call_116fe16cd6fe449c81f99b5d804d5816';

/** Lines moved in time together so that the first one is at `startMs`, keeping their recorded spacing. */
export function rebase(lines, startMs) {
  const first = Date.parse(lines[0].timestamp);
  return lines.map(line => ({ ...clone(line), timestamp: new Date(startMs + Date.parse(line.timestamp) - first).toISOString() }));
}

const v2Start = () => [
  v2(line => line.payload.call_id === V2_SPAWN_CALL && line.payload.type === 'function_call'),
  v2(line => line.payload.item?.type === 'SubAgentActivity' && line.payload.item.kind === 'started'),
  v2(line => line.payload.call_id === V2_SPAWN_CALL && line.payload.type === 'function_call_output'),
];
const v2TimedOutWait = () => [
  v2(line => line.payload.call_id === V2_WAIT_CALL && line.payload.type === 'function_call'),
  v2(line => line.payload.item?.id === V2_WAIT_CALL),
  v2(line => line.payload.call_id === V2_WAIT_CALL && line.payload.type === 'function_call_output'),
];
/** The recorded completion of another subagent of the session, naming the subagent this turn spawned. */
const v2Completion = () => {
  const line = v2(entry => entry.payload.item?.type === 'SubAgentActivity' && entry.payload.item.kind === 'completed');
  line.payload.item.agent_path = V2_TASK;
  line.payload.item.agent_thread_id = V2_LINES[1].payload.item.agent_thread_id;
  return line;
};
function sequence(groups, gapMs) {
  const lines = [];
  for (const group of groups) {
    const shifted = lines.length ? rebase(group, Date.parse(lines.at(-1).timestamp) + gapMs) : group;
    lines.push(...shifted);
  }
  return lines;
}

/** v2: spawn and its SubAgentActivity start, a wait that timed out, then SubAgentActivity completed. */
export function v2CompletedTurn(startMs) {
  return rebase(sequence([v2Start(), v2TimedOutWait(), [v2Completion()]], 2000), startMs);
}
/**
 * v2: spawn, then the subagent is interrupted. The interrupted SubAgentActivity was not recorded here; it is built from
 * the recorded completed one with `kind: "interrupted"`.
 */
export function v2InterruptedTurn(startMs) {
  const interrupted = v2Completion();
  interrupted.payload.item.kind = 'interrupted';
  interrupted.payload.item.id = interrupted.payload.item.id.replace('subagent-completed-', 'subagent-interrupted-');
  return rebase(sequence([v2Start(), [interrupted]], 2000), startMs);
}
/** v2: spawn and a wait that timed out; the finish is never seen. */
export function v2TimedOutTurn(startMs) {
  return rebase(sequence([v2Start(), v2TimedOutWait()], 2000), startMs);
}
/** v1 code mode: the recorded parent turn. */
export function v1ParentTurn(startMs) {
  return rebase(V1_PARENT_LINES, startMs);
}
/**
 * v1 code mode: the child's own rollout, on the same clock as `v1ParentTurn(startMs)`. After the recorded lines, a
 * command and the child's turn end, built from the parent's recorded exec and task_complete lines (not recorded).
 */
export function v1ChildRollout(startMs) {
  const shift = startMs - Date.parse(V1_PARENT_LINES[0].timestamp);
  const at = iso => new Date(Date.parse(iso) + shift).toISOString();
  const lines = V1_CHILD_LINES.map(line => ({ ...clone(line), timestamp: at(line.timestamp) }));
  const exec = clone(V1_PARENT_LINES[1]);
  exec.timestamp = at('2026-11-08T19:21:46.000Z');
  exec.payload = { ...exec.payload, call_id: 'call_child_exec', input: 'text("hi");\n' };
  const end = clone(V1_PARENT_LINES[8]);
  const childTurn = V1_CHILD_LINES[1].payload.turn_id;
  end.timestamp = at('2026-11-08T19:21:50.200Z');
  end.payload = { ...end.payload, turn_id: childTurn, last_agent_message: 'hi', duration_ms: 6893 };
  return [...lines, exec, end];
}

// Code mode lets an `exec` yield while its script still runs: its result, and every `wait` result while the script
// still runs, is the string `Script running with cell ID N…`; a `function_call` named `wait` with that `cell_id` reads
// more, and the result that ends the cell is a content array whose first part is the header `Script completed`,
// `Script failed` or `Script terminated`. Recorded, redacted (script, command, directory and output text replaced;
// structure, field names, times, ordinals, call ids and output headers as recorded), from real Codex sessions.

/** Recorded, redacted: Codex 0.153.4, cell 49, the exec and four waits (the last one sees it finish). */
export const CELL_A_LINES = [
  {"timestamp":"2026-09-08T01:04:25.499Z","ordinal":611,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_04eb984e11149bb7016a9f5f1809dc87d0bc3592dd9290ea12","status":"completed","call_id":"call_MGuLCSNzXmS4pLJDljVEaF1r","name":"exec","input":"<redacted js: await tools.exec_command({\"cmd\": \"...\", ...}); text(...)>","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829459.267587}}},
  {"timestamp":"2026-09-08T01:04:26.512Z","ordinal":613,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a07e8b-7f90-7672-9120-e2e69c0df240","call_id":"call_MGuLCSNzXmS4pLJDljVEaF1r","output":"Script running with cell ID 49\nWall time 1.0 seconds\nOutput:\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829466.512527}}},
  {"timestamp":"2026-09-08T01:04:33.518Z","ordinal":617,"type":"response_item","payload":{"type":"function_call","id":"fc_04eb984e11149bb7016a9f5f208c7487d098185128fd8b366c","name":"wait","arguments":"{\"cell_id\":\"49\",\"yield_time_ms\":1000,\"max_tokens\":1000}","call_id":"call_nMhsArCNzjJD2RhhAY4H3LVa","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829468.22767}}},
  {"timestamp":"2026-09-08T01:04:34.522Z","ordinal":619,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a07e8b-9eda-71e1-a215-ee37f3091a12","call_id":"call_nMhsArCNzjJD2RhhAY4H3LVa","output":"Script running with cell ID 49\nWall time 1.0 seconds\nOutput:\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829474.52244}}},
  {"timestamp":"2026-09-08T01:04:43.095Z","ordinal":623,"type":"response_item","payload":{"type":"function_call","id":"fc_04eb984e11149bb7016a9f5f2a73a887d092289e5e5720233a","name":"wait","arguments":"{\"cell_id\":\"49\",\"yield_time_ms\":1000,\"max_tokens\":1000}","call_id":"call_9gBWfvgoyk1WfOPPe6juHJDE","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829477.364432}}},
  {"timestamp":"2026-09-08T01:04:44.099Z","ordinal":625,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a07e8b-c443-78d1-9866-5b9537b5417c","call_id":"call_9gBWfvgoyk1WfOPPe6juHJDE","output":"Script running with cell ID 49\nWall time 1.0 seconds\nOutput:\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829484.0999193}}},
  {"timestamp":"2026-09-08T01:04:52.680Z","ordinal":631,"type":"response_item","payload":{"type":"function_call","id":"fc_04eb984e11149bb7016a9f5f33fa1487d0a813ad5221dbcc9d","name":"wait","arguments":"{\"cell_id\":\"49\",\"yield_time_ms\":10000,\"max_tokens\":1000}","call_id":"call_7Ugj2EbAQPkpVfwzrbENetDQ","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829485.927019}}},
  {"timestamp":"2026-09-08T01:05:03.686Z","ordinal":633,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a07e8c-10c6-7aa0-afcf-ae4bc6883d5c","call_id":"call_7Ugj2EbAQPkpVfwzrbENetDQ","output":"Script running with cell ID 49\nWall time 11.0 seconds\nOutput:\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829503.6861277}}},
  {"timestamp":"2026-09-08T01:05:36.248Z","ordinal":642,"type":"response_item","payload":{"type":"function_call","id":"fc_04eb984e11149bb7016a9f5f5f63e087d0a8cd39de0e53cdc8","name":"wait","arguments":"{\"cell_id\":\"49\",\"yield_time_ms\":1000,\"max_tokens\":1000}","call_id":"call_zWozsLOexoCQ6UxmAhTO4xYc","internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829531.121015}}},
  {"timestamp":"2026-09-08T01:05:36.547Z","ordinal":644,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a07e8c-9123-7ff2-b569-ea11e11b3848","call_id":"call_zWozsLOexoCQ6UxmAhTO4xYc","output":[{"type":"input_text","text":"Script completed\nWall time 0.0 seconds\nOutput:\n"},{"type":"input_text","text":"<redacted output part>"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a07e87-851c-72c0-a396-24a37846666f","create_time":1788829536.547119}}},
];

/**
 * Recorded, redacted: Codex 0.166.0, cell 69, the exec and three waits; two `CommandExecution` items between them are
 * commands finishing inside the cell, not its end.
 */
export const CELL_B_LINES = [
  {"timestamp":"2026-11-01T03:05:12.627Z","ordinal":606,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_0619224da6bd5bb3016ae6ac685bf48191ba1d010f9683fb73","status":"completed","call_id":"call_4188f032691b4fdc9154a3afab50e32a","name":"exec","input":"<redacted js: await tools.exec_command({\"cmd\": \"...\", ...}); text(...)>","internal_chat_message_metadata_passthrough":{"turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","create_time":1793502312.3616178}}},
  {"timestamp":"2026-11-01T03:05:13.253Z","ordinal":608,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a19511-7b25-7263-ba49-8952bc783eae","call_id":"call_4188f032691b4fdc9154a3afab50e32a","output":"Script running with cell ID 69\nWall time 0.6 seconds\nOutput:\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","create_time":1793502313.2533584}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
  {"timestamp":"2026-11-01T03:05:14.576Z","ordinal":614,"type":"response_item","payload":{"type":"function_call","status":"completed","id":"fc_0619224da6bd5bb3016ae6ac6a688c819183372eecaa18292c","name":"wait","arguments":"{\"cell_id\":\"69\",\"yield_time_ms\":1000,\"max_tokens\":6000}","call_id":"call_c364e4c478594b9997fc50c4ce1ae4fd","internal_chat_message_metadata_passthrough":{"turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","create_time":1793502314.4108431}},"metadata":{"client_authored":false,"user_input_order":26}},
  {"timestamp":"2026-11-01T03:05:15.579Z","ordinal":616,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a19511-843b-74f1-ac7b-5634abc6cfd2","call_id":"call_c364e4c478594b9997fc50c4ce1ae4fd","output":"Script running with cell ID 69\nWall time 1.0 seconds\nOutput:\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","create_time":1793502315.5794084}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
  {"timestamp":"2026-11-01T03:05:17.029Z","ordinal":620,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a19507-68ea-7790-b2d8-0443be585414","turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","item":{"type":"CommandExecution","id":"exec-70336337-1f42-486f-b091-e94d29475e13","process_id":"36310","command":"<redacted>","cwd":"<redacted>","parsed_cmd":"<redacted>","source":"unified_exec_startup","status":"completed","aggregated_output":"<redacted>","exit_code":0,"duration":{"secs":0,"nanos":13376}},"started_at_ms":1793502317029,"completed_at_ms":1793502317029}},
  {"timestamp":"2026-11-01T03:05:18.569Z","ordinal":625,"type":"response_item","payload":{"type":"function_call","status":"completed","id":"fc_0619224da6bd5bb3016ae6ac6e624c8191a03126b9cfb82d41","name":"wait","arguments":"{\"cell_id\":\"69\",\"yield_time_ms\":30000,\"max_tokens\":6000}","call_id":"call_a8d9b5ad903348a3bee08c11b57fba21","internal_chat_message_metadata_passthrough":{"turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","create_time":1793502318.3860478}},"metadata":{"client_authored":false,"user_input_order":27}},
  {"timestamp":"2026-11-01T03:05:20.992Z","ordinal":627,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a19511-9960-7380-ae3f-f2b1672449c8","call_id":"call_a8d9b5ad903348a3bee08c11b57fba21","output":"Script running with cell ID 69\nWall time 2.4 seconds\nOutput:\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","create_time":1793502320.9921167}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
  {"timestamp":"2026-11-01T03:05:24.188Z","ordinal":637,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a19507-68ea-7790-b2d8-0443be585414","turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","item":{"type":"CommandExecution","id":"exec-fcd25967-7262-40ed-8a74-f7d04354ef6e","process_id":"30995","command":"<redacted>","cwd":"<redacted>","parsed_cmd":"<redacted>","source":"unified_exec_startup","status":"completed","aggregated_output":"<redacted>","exit_code":0,"duration":{"secs":0,"nanos":6560}},"started_at_ms":1793502324188,"completed_at_ms":1793502324188}},
  {"timestamp":"2026-11-01T03:05:27.611Z","ordinal":648,"type":"response_item","payload":{"type":"function_call","status":"completed","id":"fc_0619224da6bd5bb3016ae6ac7769908191a6c8ff037c01c621","name":"wait","arguments":"{\"cell_id\":\"69\",\"yield_time_ms\":30000,\"max_tokens\":6000}","call_id":"call_24db32c89b7c43b1b1b0657a8a47aa32","internal_chat_message_metadata_passthrough":{"turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","create_time":1793502327.4154603}},"metadata":{"client_authored":false,"user_input_order":31}},
  {"timestamp":"2026-11-01T03:05:42.638Z","ordinal":650,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a19511-edee-7aa3-ba29-3a531f3ae2a4","call_id":"call_24db32c89b7c43b1b1b0657a8a47aa32","output":[{"type":"input_text","text":"Script completed\nWall time 15.0 seconds\nOutput:\n"},{"type":"input_text","text":"<redacted output part>"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a19508-2a17-74b1-924b-88793f0d3e05","create_time":1793502342.638817}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
];

/** Recorded, redacted: Codex 0.166.0, cell 1, the exec, one inner `CommandExecution` and one wait that sees it finish. */
export const CELL_C_LINES = [
  {"timestamp":"2026-11-01T03:44:06.667Z","ordinal":23,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_00878406a5b343eb016ae6b58614348191b7e086b8708c442e","status":"completed","call_id":"call_eb63dba798f24ab0bb47114320d2d5ef","name":"exec","input":"<redacted js: await tools.exec_command({\"cmd\": \"...\", ...}); text(...)>","internal_chat_message_metadata_passthrough":{"turn_id":"01a19535-0054-7161-b9ce-b8a213148c29","create_time":1793504646.0816913}}},
  {"timestamp":"2026-11-01T03:44:06.740Z","ordinal":25,"type":"response_item","payload":{"type":"custom_tool_call_output","id":"ctco_01a19535-1654-73a1-9bf5-dd531ac2ab8d","call_id":"call_eb63dba798f24ab0bb47114320d2d5ef","output":"Script running with cell ID 1\nWall time 0.0 seconds\nOutput:\n","internal_chat_message_metadata_passthrough":{"turn_id":"01a19535-0054-7161-b9ce-b8a213148c29","create_time":1793504646.7407892}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
  {"timestamp":"2026-11-01T03:44:06.766Z","ordinal":27,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a19534-fe52-71c3-977b-c102c472e091","turn_id":"01a19535-0054-7161-b9ce-b8a213148c29","item":{"type":"CommandExecution","id":"exec-56c9fd22-ac0c-4e21-9408-caa2e4ee4616","process_id":"66558","command":"<redacted>","cwd":"<redacted>","parsed_cmd":"<redacted>","source":"unified_exec_startup","status":"completed","aggregated_output":"<redacted>","exit_code":0,"duration":{"secs":0,"nanos":8432}},"started_at_ms":1793504646766,"completed_at_ms":1793504646766}},
  {"timestamp":"2026-11-01T03:44:08.762Z","ordinal":32,"type":"response_item","payload":{"type":"function_call","status":"completed","id":"fc_00878406a5b343eb016ae6b58811d4819180b5d9e1a77cb991","name":"wait","arguments":"{\"cell_id\":\"1\",\"yield_time_ms\":10000,\"max_tokens\":30000}","call_id":"call_83e899c0948c46e0a06750de995bb548","internal_chat_message_metadata_passthrough":{"turn_id":"01a19535-0054-7161-b9ce-b8a213148c29","create_time":1793504648.1350896}},"metadata":{"client_authored":false,"user_input_order":3}},
  {"timestamp":"2026-11-01T03:44:08.826Z","ordinal":34,"type":"response_item","payload":{"type":"function_call_output","id":"fco_01a19535-1e7a-7c81-918b-7876e607a24f","call_id":"call_83e899c0948c46e0a06750de995bb548","output":[{"type":"input_text","text":"Script completed\nWall time 0.0 seconds\nOutput:\n"},{"type":"input_text","text":"<redacted output part>"}],"internal_chat_message_metadata_passthrough":{"turn_id":"01a19535-0054-7161-b9ce-b8a213148c29","create_time":1793504648.8262641}},"metadata":{"client_authored":false,"fallback_token_limit_override":12000}},
];

/**
 * Group C with its finishing header swapped to `Script failed` (followed by a `Script error: …` part) or
 * `Script terminated`. Built from the recorded finishing line: no failed or terminated cell was recorded here.
 */
export function cellEndingAs(header) {
  const lines = clone(CELL_C_LINES), last = lines.at(-1);
  const [first, ...rest] = last.payload.output;
  last.payload.output = [{ ...first, text: first.text.replace(/^Script completed/, header) },
    ...(header === 'Script failed' ? [{ type: 'input_text', text: 'Script error: <redacted>' }] : rest)];
  return lines;
}

/**
 * The recorded v1 turn, with its wait exec yielding once and its result read by a `wait` on that cell. The yield and
 * the wait are built after the recorded group C lines (a running result is a string, the wait names only `cell_id`,
 * `yield_time_ms` and `max_tokens`); the finishing result is the recorded v1 wait result.
 */
export function v1YieldedWaitTurn(startMs) {
  const lines = v1ParentTurn(startMs);
  const index = lines.findIndex(line => line.payload.call_id === V1_WAIT_EXEC && line.payload.type === 'custom_tool_call_output');
  const recorded = lines[index], at = Date.parse(recorded.timestamp);
  const yielded = { ...clone(recorded), timestamp: new Date(at - 300).toISOString() };
  yielded.payload.output = clone(CELL_C_LINES[1]).payload.output.replace('cell ID 1', 'cell ID 2');
  const call = clone(CELL_C_LINES[3]);
  call.timestamp = new Date(at - 200).toISOString();
  call.payload = { ...call.payload, call_id: 'call_cell_wait', arguments: JSON.stringify({ cell_id: '2', yield_time_ms: 10000, max_tokens: 30000 }) };
  const result = clone(CELL_C_LINES[4]);
  result.timestamp = recorded.timestamp;
  result.payload = { ...result.payload, call_id: 'call_cell_wait', output: recorded.payload.output };
  return [...lines.slice(0, index), yielded, call, result, ...lines.slice(index + 1)];
}

/**
 * The child's own rollout as a long one: after its recorded first lines, enough reasoning lines (the shape Codex
 * writes, content redacted) that a collector reads the rest in later passes, then the built command and turn end of
 * `v1ChildRollout`.
 */
export function v1LongChildRollout(startMs, { lines = 300 } = {}) {
  const [meta, started, ...rest] = v1ChildRollout(startMs);
  const filler = Array.from({ length: lines }, (_, index) => ({ timestamp: started.timestamp, type: 'response_item',
    payload: { type: 'reasoning', summary: [], content: null, encrypted_content: `<redacted>${'x'.repeat(1000)}${index}` } }));
  return [meta, started, ...filler, ...rest];
}
