import path from 'node:path';

const CREDENTIAL_PATTERNS = [
  [/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]'],
  [/xoxb-[a-zA-Z0-9-]+/g, '[REDACTED]'],
  [/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]'],
  [/Bearer\s+[a-zA-Z0-9._\-]+/g, 'Bearer [REDACTED]'],
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]']
];

const STRIP_KEYS = new Set([
  'tool_input', 'tool_response', 'tool_output',
  'prompt', 'content', 'message'
]);

const DEFAULT_SUMMARY_LIMIT = 500;

export class Sanitizer {
  constructor(zylosDir) {
    this.zylosDir = zylosDir;
  }

  sanitizeHookPayload(hookEventName, rawPayload) {
    try {
      const session_id = rawPayload.session_id || null;
      const duration_ms = rawPayload.duration_ms || null;
      const tool_name = rawPayload.tool_name || rawPayload.tool || null;
      const tool_use_id = rawPayload.tool_use_id || null;

      const tool_detail = this._extractToolDetail(tool_name, rawPayload.tool_input);

      let prompt_source = null;
      if (hookEventName === 'UserPromptSubmit' && typeof rawPayload.prompt === 'string') {
        prompt_source = this._extractPromptSource(rawPayload.prompt);
      }

      const metadata = {};
      if (tool_name) metadata.tool_name = tool_name;
      if (tool_use_id) metadata.tool_use_id = tool_use_id;
      if (tool_detail) metadata.tool_detail = tool_detail;
      if (prompt_source) metadata.prompt_source = prompt_source;

      const safeFields = [
        'timestamp',
        'hook_event_name',
        'runtime',
        'turn_id',
        'transcript_path',
        'model',
        'permission_mode'
      ];
      for (const key of safeFields) {
        if (rawPayload[key] !== undefined) metadata[key] = rawPayload[key];
      }

      this._redactObject(metadata);

      for (const key of STRIP_KEYS) {
        delete metadata[key];
      }

      const agentId = rawPayload.agent_id || null;
      const agentType = rawPayload.agent_type || null;
      if (agentId) metadata.agent_id = agentId;
      if (agentType) metadata.agent_type = agentType;

      if (hookEventName === 'SubagentStop' || hookEventName === 'Stop') {
        const msg = rawPayload.last_assistant_message;
        if (typeof msg === 'string' && msg.length > 0) {
          metadata.assistant_summary = this.safeAssistantSummary(msg, 200);
        }
      }

      const summary = this.buildSummary(hookEventName, tool_name, duration_ms, tool_detail, prompt_source, metadata.assistant_summary);

      return { session_id, duration_ms, summary, metadata };
    } catch {
      return {
        session_id: null,
        duration_ms: null,
        summary: hookEventName || 'unknown event',
        metadata: {}
      };
    }
  }

  sanitizePath(fullPath) {
    if (!fullPath || typeof fullPath !== 'string') return '';
    const rel = path.relative(this.zylosDir, fullPath);
    if (rel.startsWith('..')) return path.basename(fullPath);
    const parts = rel.split('/');
    if (parts.length <= 3) return rel;
    return parts.slice(-3).join('/');
  }

  redactCredentials(text) {
    if (typeof text !== 'string') return text;
    let result = text;
    for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  safeSummary(text, limit = DEFAULT_SUMMARY_LIMIT) {
    if (typeof text !== 'string') return null;
    const redacted = this.redactCredentials(text.trim().replace(/\s+/g, ' '));
    if (!redacted) return null;
    return redacted.length > limit ? redacted.slice(0, limit - 3) + '...' : redacted;
  }

  safeAssistantSummary(text, limit = DEFAULT_SUMMARY_LIMIT) {
    return this.safeSummary(text, limit);
  }

  buildSummary(hookEventName, toolName, durationMs, toolDetail, promptSource, assistantSummary) {
    const detail = toolDetail ? `: ${toolDetail}` : '';
    switch (hookEventName) {
      case 'SessionStart':
        return 'Session started';
      case 'PreToolUse':
        return `${toolName || 'Unknown'}${detail}`;
      case 'PostToolUse':
        return `${toolName || 'Unknown'}${detail}`;
      case 'UserPromptSubmit':
        return promptSource ? `Prompt from ${promptSource}` : 'Prompt received';
      case 'Stop':
        return assistantSummary || 'Turn ended';
      case 'PermissionRequest':
        return `Permission requested: ${toolName || 'Unknown'}${detail}`;
      case 'SubagentStart':
        return 'Subagent started';
      case 'SubagentStop':
        return 'Subagent completed';
      default:
        return hookEventName || 'unknown event';
    }
  }

  _extractToolDetail(toolName, toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return null;
    try {
      if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
        const fp = toolInput.file_path;
        return fp ? this.sanitizePath(fp) : null;
      }
      if (toolName === 'Bash') {
        if (toolInput.description) return toolInput.description;
        return this._summarizeBashCommand(toolInput.command);
      }
      if (toolName === 'Skill') {
        return toolInput.skill || null;
      }
      if (toolName === 'Agent' || toolName === 'Task') {
        return toolInput.description || null;
      }
      if (toolName === 'WebSearch') {
        return toolInput.query ? `"${toolInput.query}"` : null;
      }
      if (toolName === 'WebFetch') {
        try {
          const u = new URL(toolInput.url || '');
          return u.hostname + u.pathname;
        } catch { return null; }
      }
    } catch { /* extraction failed — not critical */ }
    return null;
  }

  _summarizeBashCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return null;

    let line = cmd.split('\n')[0].trim();

    // Strip leading comment-only lines
    if (/^#\s/.test(line)) {
      const lines = cmd.split('\n');
      for (const l of lines) {
        const t = l.trim();
        if (t && !/^#\s/.test(t)) { line = t; break; }
      }
      if (/^#\s/.test(line)) return line.slice(0, 60);
    }

    // Strip shell chains: cd xxx && actual_command → actual_command
    line = line.replace(/^cd\s+\S+\s*&&\s*/i, '');
    // Strip leading env exports: export $(grep...) && cmd → cmd
    line = line.replace(/^export\s+\$\([^)]*\)\s*&&\s*/i, '');

    const friendly = this._friendlyC4Label(line);
    if (friendly) return friendly;

    // Take first command in a pipe chain (quote-aware)
    const pipeIdx = this._findUnquotedPipe(line);
    const pipeCmd = pipeIdx > 0 ? line.slice(0, pipeIdx).trimEnd() : line;

    // Strip redirections at the end
    let clean = pipeCmd.replace(/\s+\d*>[>&]?\s*\S+\s*$/g, '').trim();

    // Shorten filesystem paths (preceded by whitespace/quote/start, not inside URLs)
    clean = clean.replace(/(?<=^|[\s"'=])(?:\/(?:home|Users|tmp|var|usr|opt|etc|root)(?:\/[\w.@+-]+){3,}|~(?:\/[\w.@+-]+){3,})/g, (p) => this._shortenPath(p));

    // Truncate
    if (pipeIdx > 0 && clean.length < 70) clean += ' | ...';
    return clean.length > 80 ? clean.slice(0, 77) + '...' : clean;
  }

  _friendlyC4Label(line) {
    // Try line start first, then after an unquoted pipe (heredoc stdin form)
    const cmd = this._c4CommandSegment(line);
    if (!cmd) return null;

    const sendMatch = cmd.match(/^node\s+(?:\S*\/)?c4-send\.js\s+"([^"]+)"(?:\s+"([^"]*)")?/);
    if (sendMatch) {
      const channel = sendMatch[1];
      const target = sendMatch[2] ? this._extractC4Target(sendMatch[2]) : null;
      return target ? `Send to ${channel} (${target})` : `Send to ${channel}`;
    }

    const ctrlMatch = cmd.match(/^node\s+(?:\S*\/)?c4-control\.js\s+(\w+)/);
    if (ctrlMatch) {
      const sub = ctrlMatch[1];
      const idMatch = cmd.match(/--id\s+"?(\d+)"?/);
      if (idMatch) return `Control: ${sub} #${idMatch[1]}`;
      return `Control: ${sub}`;
    }

    return null;
  }

  _extractPromptSource(prompt) {
    // "reply via: node .../c4-send.js "channel" "endpoint""
    const replyVia = prompt.match(/reply via:\s*node\s+\S*c4-send\.js\s+"([^"]+)"(?:\s+"([^"]*)")?/);
    if (replyVia) {
      const channel = replyVia[1];
      const target = replyVia[2] ? this._extractC4Target(replyVia[2]) : null;
      return target ? `${channel} (${target})` : channel;
    }

    // "ack via: node .../c4-control.js ack --id ..."
    if (/ack via:/.test(prompt)) return 'control';

    // Scheduler task delivery
    if (/\[Scheduled Task\]|\[scheduler\]/i.test(prompt)) return 'scheduler';

    return null;
  }

  _c4CommandSegment(line) {
    if (/^node\s+/.test(line)) return line;
    const pipeIdx = this._findUnquotedPipe(line);
    if (pipeIdx < 0) return null;
    return line.slice(pipeIdx + 1).trimStart();
  }

  _extractC4Target(endpoint) {
    const parts = endpoint.split('|');
    for (const p of parts) {
      if (/^(msg|req|org):/.test(p)) continue;
      return p;
    }
    return parts[0];
  }

  _findUnquotedPipe(str) {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\\' && !inSingle) { i++; continue; }
      if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (ch === '|' && !inSingle && !inDouble) {
        if (str[i + 1] === '|') { i++; continue; }
        return i;
      }
    }
    return -1;
  }

  _shortenPath(fullPath) {
    const parts = fullPath.split('/').filter(Boolean);
    if (parts.length <= 3) return fullPath;
    return parts.slice(-3).join('/');
  }

  _redactObject(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        obj[key] = this.redactCredentials(value);
      } else if (value && typeof value === 'object') {
        this._redactObject(value);
      }
    }
  }
}
