---
name: check-context
description: Accurately check current context window and token usage. Use when the user asks about context usage, token consumption, or when monitoring context levels.
---

# Check Context Skill

Check current context/token usage. The data source depends on the active runtime.

## When to Use

- When the user asks about context usage
- When the user wants to know token consumption

## How to Use

First, check the active runtime:

```bash
node -e "try { const c=JSON.parse(require('fs').readFileSync(require('path').join(process.env.HOME,'zylos/.zylos/config.json'),'utf8')); console.log(c.runtime||'claude'); } catch { console.log('claude'); }"
```

### If Claude runtime

Read the statusLine data file (updated after every turn):

```bash
cat ~/zylos/activity-monitor/statusline.json
```

Report from the JSON:
- **Context usage**: `context_window.used_percentage`% used, `context_window.remaining_percentage`% remaining
- **Tokens**: `context_window.total_input_tokens` input, `context_window.total_output_tokens` output (window size: `context_window.context_window_size`)
- **Session cost**: `cost.total_cost_usd`
- **Model**: `model.display_name`

### If Codex runtime

Read token usage from the most recently modified Codex JSONL session file:

```bash
node -e "
const fs=require('fs'),path=require('path');
const base=path.join(process.env.HOME,'.codex/sessions');
let best=null,bestMtime=0;
function walk(d,depth){if(depth>3)return;try{fs.readdirSync(d).forEach(f=>{const p=path.join(d,f);try{const s=fs.statSync(p);if(s.isDirectory())walk(p,depth+1);else if(f.startsWith('rollout-')&&f.endsWith('.jsonl')&&s.mtimeMs>bestMtime){bestMtime=s.mtimeMs;best=p;}}catch{}});}catch{}}
walk(base,0);
if(!best){console.log('No session found');process.exit(0);}
const lines=fs.readFileSync(best,'utf8').split('\n').filter(Boolean);
for(let i=lines.length-1;i>=0;i--){try{const j=JSON.parse(lines[i]);if(j.type==='event_msg'&&j.payload?.type==='token_count'&&j.payload.info.last_token_usage){const u=j.payload.info.last_token_usage.input_tokens;const c=j.payload.info.model_context_window||128000;console.log('used:'+u+' ceiling:'+c+' pct:'+Math.round(u/c*100)+'%');process.exit(0);}}catch{}}
console.log('No token_count event found');
"
```

Report:
- **Context usage**: pct% used (used / ceiling tokens)
- Report the pct value clearly so the user knows if rotation is needed (threshold: 75%)
