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
node -e "try { const c=JSON.parse(require('fs').readFileSync(require('path').join(process.env.HOME,'.zylos/config.json'),'utf8')); console.log(c.runtime||'claude'); } catch { console.log('claude'); }"
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

Read token usage from Codex's SQLite state:

```bash
# Tokens used (most recent active thread)
sqlite3 ~/.codex/state_5.sqlite "SELECT tokens_used FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 1;"

# Context window ceiling from models cache
node -e "try { const c=JSON.parse(require('fs').readFileSync(require('path').join(process.env.HOME,'.codex/models_cache.json'),'utf8')); const m=c.models[0]; console.log(Math.round(m.context_window*(m.effective_context_window_percent||100)/100)); } catch { console.log(128000); }"
```

Calculate usage percentage: `(tokens_used / ceiling) * 100`.

Report:
- **Context usage**: X% used (tokens_used / ceiling tokens)
- **Model**: first entry in `~/.codex/models_cache.json`
