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

// Code mode lets an `exec` yield while its script still runs (`Script running with cell ID …`); `wait` with that
// `cell_id` then returns more output, until a result reports `Script completed`. No such lines were recorded: they are
// built from the recorded v1 exec lines above, with the output header, the `wait` tool name and its arguments
// (`cell_id`, `yield_time_ms`) as the Codex 0.167.0 binary describes them.
const CELL = '7';
const runningOutput = (seconds = 10) => [{ type: 'input_text', text: `Script running with cell ID ${CELL}\nWall time ${seconds}.0 seconds\nOutput:\n` }];
function waitLines(callId, at, doneAt, output) {
  const call = clone(V1_PARENT_LINES[1]);
  call.timestamp = at;
  call.payload = { type: 'function_call', status: 'completed', name: 'wait', arguments: JSON.stringify({ cell_id: CELL, yield_time_ms: 10000 }),
    call_id: callId, internal_chat_message_metadata_passthrough: call.payload.internal_chat_message_metadata_passthrough };
  const result = clone(V1_PARENT_LINES[3]);
  result.timestamp = doneAt;
  result.payload = { ...result.payload, type: 'function_call_output', call_id: callId, output };
  delete result.payload.id;
  return [call, result];
}
const stamp = (startMs, seconds) => new Date(startMs + seconds * 1000).toISOString();

/**
 * A command run from code mode that yields twice: the exec, a wait still running, a wait that sees it finish. The
 * script prints the command's result; `exitCode` sets its exit code.
 */
export function codeModeYieldedCommand(startMs, { exitCode = 0 } = {}) {
  const exec = clone(V1_PARENT_LINES[1]);
  exec.timestamp = stamp(startMs, 0);
  exec.payload = { ...exec.payload, call_id: 'call_cell_exec', input: 'const r = await tools.exec_command({cmd: "<redacted>"});\ntext(JSON.stringify(r));\n' };
  const yielded = clone(V1_PARENT_LINES[3]);
  yielded.timestamp = stamp(startMs, 10);
  yielded.payload = { ...yielded.payload, call_id: 'call_cell_exec', output: runningOutput() };
  const finished = [{ type: 'input_text', text: 'Script completed\nWall time 4.2 seconds\nOutput:\n' },
    { type: 'input_text', text: JSON.stringify({ exit_code: exitCode, output: '<redacted>' }) }];
  return [exec, yielded,
    ...waitLines('call_cell_wait_1', stamp(startMs, 11), stamp(startMs, 21), runningOutput()),
    ...waitLines('call_cell_wait_2', stamp(startMs, 22), stamp(startMs, 26), finished)];
}

/** The recorded v1 turn, with its wait exec yielding once and the wait result read by a `wait` on its cell. */
export function v1YieldedWaitTurn(startMs) {
  const lines = v1ParentTurn(startMs);
  const index = lines.findIndex(line => line.payload.call_id === V1_WAIT_EXEC && line.payload.type === 'custom_tool_call_output');
  const recorded = lines[index], at = Date.parse(recorded.timestamp);
  const yielded = { ...clone(recorded), timestamp: new Date(at - 300).toISOString() };
  yielded.payload.output = runningOutput(0);
  const [call, result] = waitLines('call_cell_wait', new Date(at - 200).toISOString(), recorded.timestamp, recorded.payload.output);
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
