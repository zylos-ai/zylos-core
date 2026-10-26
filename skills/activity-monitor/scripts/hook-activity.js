#!/usr/bin/env node
import { loadCoreModule } from './core-modules.js';
/** Record native hook facts; state is derived by the supervisor. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { appendEvent } = await loadCoreModule('event-log.js');
const { runDirFromEnv, RUN_FILES, hookErrorLogPath } = await loadCoreModule('session-group-paths.js');

const EVENTS = { SessionStart:'session_start', UserPromptSubmit:'prompt', PreToolUse:'pre_tool', PostToolUse:'post_tool', PostToolUseFailure:'post_tool_failure', PermissionRequest:'permission_request', Stop:'stop', Notification:'idle', SubagentStart:'subagent_start', SubagentStop:'subagent_stop' };
const INPUT_FIELDS = { Bash:['command','description'], Read:['file_path'], Edit:['file_path'], Write:['file_path'], Skill:['skill'], Agent:['description','subagent_type'], Task:['description','subagent_type'], WebSearch:['query'], WebFetch:['url'], view_image:['path'] };
export function selectToolInput(tool, input) {
  if (tool === 'apply_patch') {
    const patch = typeof input === 'string' ? input : input?.patch ?? input?.input;
    return typeof patch === 'string' ? { file_paths: [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match=>match[1]) } : undefined;
  }
  if (!input || typeof input !== 'object' || !INPUT_FIELDS[tool]) return undefined;
  return Object.fromEntries(INPUT_FIELDS[tool].filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
}
export function handleHookActivity(data, { nowMs=Date.now(), env=process.env } = {}) {
  const event=EVENTS[data?.hook_event_name];
  if (!event || (event==='idle' && data.notification_type!=='idle_prompt')) return null;
  const location=runDirFromEnv(env);
  const runtime=env.ZYLOS_MODEL_CONFIG ? JSON.parse(env.ZYLOS_MODEL_CONFIG).runtime : 'claude';
  if (!['claude','codex'].includes(runtime) || typeof data.session_id!=='string' || !data.session_id) return null;
  const record={v:1,ts:nowMs,event,runtime,session_group:location.kind==='legacy'?null:(location.sessionGroup || 'origin'),run_id:env.ZYLOS_RUN_ID || null,session_id:data.session_id};
  for(const field of ['agent_id','agent_type','turn_id','model','permission_mode','transcript_path']) if(Object.hasOwn(data,field))record[field]=data[field];
  if(['pre_tool','post_tool','post_tool_failure','permission_request'].includes(event)) {
    if(Object.hasOwn(data,'tool_name'))record.tool=data.tool_name;
    if(Object.hasOwn(data,'tool_use_id'))record.tool_use_id=data.tool_use_id;
    const selected=selectToolInput(data.tool_name,data.tool_input);if(selected!==undefined)record.tool_input=selected;
  }
  if(['post_tool','post_tool_failure'].includes(event) && Object.hasOwn(data,'duration_ms'))record.duration_ms=data.duration_ms;
  if(event==='post_tool_failure' && Object.hasOwn(data,'error'))record.error=data.error;
  if(['stop','subagent_stop'].includes(event) && Object.hasOwn(data,'last_assistant_message'))record.last_assistant_message=data.last_assistant_message;
  if(event==='idle')record.notification_type=data.notification_type;
  appendEvent(path.join(location.dir,RUN_FILES.EVENTS),record);
  return record;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.env.HOOK_ACTIVITY_DISABLE_MAIN!=='1') {
  let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;});
  process.stdin.on('end',()=>{try{handleHookActivity(JSON.parse(input || '{}'));}catch(error){try{fs.appendFileSync(hookErrorLogPath(),`${new Date().toISOString()} group=${process.env.ZYLOS_SESSION_GROUP || ''} run=${process.env.ZYLOS_RUN_ID || ''} ${error.message}\n`);}catch{}}});
}
