---
name: check-context
description: Accurately check current context window and token usage. Use when the user asks about context usage, token consumption, or when monitoring context levels.
user-invocable: false
---

# Check Context Skill

Check this session's current context/token usage. The data source depends on this session's runtime.

## When to Use

- When the user asks about context usage
- When the user wants to know token consumption

## How to Use

First, check this session's runtime (falls back to the instance default):

```bash
node -e "let r;try{r=JSON.parse(process.env.ZYLOS_MODEL_CONFIG||'{}').runtime}catch{}if(!r){try{r=JSON.parse(require('fs').readFileSync(require('path').join(process.env.HOME,'zylos/.zylos/config.json'),'utf8')).runtime}catch{}}console.log(r||'claude')"
```

### If Claude runtime

Read the statusLine data file of the current session group (updated after every turn):

```bash
cat ~/zylos/activity-monitor/session-groups/"${ZYLOS_SESSION_GROUP:-origin}"/statusline.json
```

Report from the JSON:
- **Context usage**: `context_window.used_percentage`% used, `context_window.remaining_percentage`% remaining
- **Tokens**: `context_window.total_input_tokens` input, `context_window.total_output_tokens` output (window size: `context_window.context_window_size`)
- **Session cost**: `cost.total_cost_usd`
- **Model**: `model.display_name`

### If Codex runtime

Read token usage from this session's Codex rollout file (recorded in the session group's events at session start):

```bash
node -e "
const fs=require('fs'),path=require('path');
const dir=path.join(process.env.HOME,'zylos/activity-monitor/session-groups',process.env.ZYLOS_SESSION_GROUP||'origin');
const rows=f=>{try{return fs.readFileSync(f,'utf8').split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}})}catch{return []}};
const start=rows(path.join(dir,'events.jsonl')).findLast(r=>r.event==='session_start'&&r.runtime==='codex'&&r.run_id===process.env.ZYLOS_RUN_ID);
if(!start?.transcript_path){console.log('No Codex session found for this run');process.exit(0);}
const row=rows(start.transcript_path).findLast(r=>r.type==='event_msg'&&r.payload?.type==='token_count'&&r.payload.info?.last_token_usage);
if(!row){console.log('No token_count event found');process.exit(0);}
const u=row.payload.info.last_token_usage.input_tokens,c=row.payload.info.model_context_window;
console.log(c?'used:'+u+' ceiling:'+c+' pct:'+Math.round(u/c*100)+'%':'used:'+u+' ceiling:unknown');
"
```

Report:
- **Context usage**: pct% used (used / ceiling tokens)
- Report the pct value clearly. The new-session threshold is set per model in the Dashboard.

### If Antigravity (`agy`) runtime

Read the statusLine data file of the current session group (updated when the agent's status changes):

```bash
cat ~/zylos/activity-monitor/session-groups/"${ZYLOS_SESSION_GROUP:-origin}"/statusline.json
```

Report from the JSON:
- **Context usage**: `context_window.used_percentage`% used
- **Window size**: `context_window.context_window_size` tokens
- **Model**: `model.id`
