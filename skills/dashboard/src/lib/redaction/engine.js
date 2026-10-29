import { createHash } from 'node:crypto';
import { createRedactionWorker } from './worker-client.js';
import { rules, globalAllowlist, RULE_VERSION } from './rules.generated.js';
import { dashboardSpans } from './layers/dashboard-tokens.js';
import { SENSITIVE_KEY, keynameSpans } from './layers/keyname.js';
import { KnownValues } from './layers/known-values.js';
export const UNAVAILABLE = '此内容暂时无法安全显示';
const compiled = rules.map((r) => ({
  ...r,
  expression: new RegExp(r.regex, 'gd' + (r.flags || '')),
}));
const keywords = [...new Set(rules.flatMap((r) => r.keywords || []).map((k) => k.toLowerCase()))];
const keywordPattern = new RegExp(
  '(?=(' +
    keywords
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|') +
    '))',
  'g',
);
const prefixes = [
  'sk-ant-api03-',
  'sk-ant-admin01-',
  'sk-proj-',
  'sk-svcacct-',
  'sk-or-v1-',
  'sk-api-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'AKIA',
  'ASIA',
  'xoxb-',
  'xoxp-',
  'xoxs-',
  'xoxa-',
  'gsk_',
  'xai-',
];
function entropy(value) {
  const counts = new Map();
  for (const c of value) counts.set(c, (counts.get(c) || 0) + 1);
  let n = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    n -= p * Math.log2(p);
  }
  return n;
}
function allowed(secret, match, line, lists) {
  return lists.some((a) => {
    const tests = [];
    if (a.regexes?.length)
      tests.push(
        a.regexes.some((r) =>
          new RegExp(r.regex, r.flags || '').test(
            a.regexTarget === 'match' ? match : a.regexTarget === 'line' ? line : secret,
          ),
        ),
      );
    if (a.stopwords?.length)
      tests.push(a.stopwords.some((s) => secret.toLowerCase().includes(s.toLowerCase())));
    return tests.length > 0 && (a.condition === 'AND' ? tests.every(Boolean) : tests.some(Boolean));
  });
}
export function findSpans(text, { knownValues = [], allowlist = [], _depth = 0 } = {}) {
  if (typeof text !== 'string') throw new TypeError('redaction expects text');
  const spans = [];
  for (const { value, label } of knownValues) {
    if (!value) continue;
    let start = 0;
    while ((start = text.indexOf(value, start)) !== -1) {
      spans.push({ start, end: start + value.length, ruleId: 'known-value', label, priority: 0 });
      start += value.length;
    }
  }
  spans.push(...dashboardSpans(text), ...keynameSpans(text));
  const lower = text.toLowerCase();
  keywordPattern.lastIndex = 0;
  const hits = new Set();
  for (const match of lower.matchAll(keywordPattern)) hits.add(match[1]);
  const present = new Set(keywords.filter((k) => [...hits].some((hit) => hit.includes(k))));
  for (const rule of compiled) {
    if (rule.id === 'private-key' && !text.includes('-----END')) continue;
    if (rule.keywords?.length && !rule.keywords.some((k) => present.has(k.toLowerCase()))) continue;
    rule.expression.lastIndex = 0;
    for (const m of text.matchAll(rule.expression)) {
      const group =
        rule.secretGroup ||
        Math.max(
          0,
          m.findIndex((v, i) => i > 0 && v),
        );
      const value = m[group];
      const indices = m.indices[group];
      const line = text.slice(
        text.lastIndexOf('\n', m.index) + 1,
        text.indexOf('\n', m.index + m[0].length) === -1
          ? text.length
          : text.indexOf('\n', m.index + m[0].length),
      );
      if (
        !value ||
        !indices ||
        (rule.entropy && entropy(value) <= rule.entropy) ||
        allowed(value, m[0], line, [...globalAllowlist, ...(rule.allowlists || [])])
      )
        continue;
      spans.push({
        start: indices[0],
        end: indices[1],
        ruleId: rule.id,
        label: rule.label || rule.id,
        keepPrefix: prefixes.find((p) => value.startsWith(p)),
      });
    }
  }
  // JSON serialized PEM includes literal backslash-n sequences, not physical newlines.
  if (text.includes('-----END'))
    for (const m of text.matchAll(
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    ))
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        ruleId: 'private-key',
        label: 'Private key',
      });
  // A tool output can itself contain JSON serialized inside another JSON string.
  // Decode one escape layer with an offset map, then map detected spans back to
  // the original field. No decoded text is sent to the caller.
  if (_depth >= 8 && /\\["\\]/.test(text)) throw new Error('Nested escape limit exceeded');
  if (_depth < 8 && /\\["\\]/.test(text)) {
    const starts = [],
      ends = [];
    let decoded = '',
      cursor = 0;
    for (const m of text.matchAll(/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/g)) {
      for (let i = cursor; i < m.index; i++) {
        decoded += text[i];
        starts.push(i);
        ends.push(i + 1);
      }
      const value = JSON.parse('"' + m[0] + '"');
      for (const c of value) {
        decoded += c;
        starts.push(m.index);
        ends.push(m.index + m[0].length);
      }
      cursor = m.index + m[0].length;
    }
    for (let i = cursor; i < text.length; i++) {
      decoded += text[i];
      starts.push(i);
      ends.push(i + 1);
    }
    if (decoded !== text)
      for (const span of findSpans(decoded, { knownValues, allowlist, _depth: _depth + 1 })) {
        spans.push({
          ...span,
          start: starts[span.start],
          end: ends[span.end - 1],
          keepPrefix: undefined,
        });
      }
  }
  const filtered = spans.filter(
    (s) => s.ruleId === 'dashboard-credential' || !allowlist.includes(text.slice(s.start, s.end)),
  );
  filtered.sort(
    (a, b) => a.start - b.start || (a.priority ?? 1) - (b.priority ?? 1) || b.end - a.end,
  );
  const merged = [];
  for (const s of filtered) {
    const previous = merged.at(-1);
    if (previous && s.start < previous.end) {
      const end = Math.max(previous.end, s.end);
      if ((s.priority ?? 1) < (previous.priority ?? 1))
        Object.assign(previous, {
          ruleId: s.ruleId,
          label: s.label,
          priority: s.priority,
          keepPrefix: undefined,
        });
      previous.end = end;
      if (
        previous.keepPrefix &&
        !text.slice(previous.start, previous.end).startsWith(previous.keepPrefix)
      )
        previous.keepPrefix = undefined;
    } else merged.push({ ...s });
  }
  return merged;
}
export function redact(text, options = {}) {
  const spans = findSpans(text, options);
  let output = '',
    cursor = 0;
  for (const span of spans) {
    // Never reproduce Fleet guard vocabulary, even in rule labels or prefix hints.
    const label = span.label.replace(
      /read_api_key|read_session_token|zylos_(?:st|ak)_/gi,
      'credential',
    );
    output +=
      text.slice(cursor, span.start) +
      `[已遮蔽 · ${label}${span.keepPrefix ? ' · ' + span.keepPrefix + '…' : ''} · ${span.end - span.start} 字符]`;
    cursor = span.end;
  }
  return {
    text: output + text.slice(cursor),
    count: spans.length,
    kinds: [...new Set(spans.map((s) => s.ruleId))],
  };
}
const fail = () => ({ text: UNAVAILABLE, count: 0, kinds: [], failed: true });
export function createRedactor({
  zylosDir,
  allowlist = [],
  timeoutMs = 5000,
  maxCacheBytes = 16 * 1024 * 1024,
  maxCacheEntries = 1024,
  workerURL = new URL('./worker.js', import.meta.url),
} = {}) {
  allowlist = [...allowlist];
  const known = new KnownValues(zylosDir);
  const cache = new Map();
  const worker = createRedactionWorker({ workerURL, timeoutMs, failure: fail });
  let cacheBytes = 0;
  let refreshPromise;
  let closed = false;
  async function snapshot() {
    refreshPromise ??= known.refresh().finally(() => {
      refreshPromise = undefined;
    });
    await refreshPromise;
    return { knownValues: known.values, revision: known.revision };
  }
  async function safe(text, cacheKey = '', current) {
    try {
      if (closed || typeof text !== 'string') return fail();
      current ??= await snapshot();
      const key = createHash('sha256')
        .update(`${RULE_VERSION}:${current.revision}:${cacheKey}:`)
        .update(text)
        .digest('hex');
      if (cache.has(key)) {
        const hit = cache.get(key);
        cache.delete(key);
        cache.set(key, hit);
        return hit.result;
      }
      const options = { knownValues: current.knownValues, allowlist };
      const result = await worker.run(text, options);
      if (!result.failed) {
        const size = Buffer.byteLength(result.text) + 256;
        if (size <= maxCacheBytes) {
          if (cache.has(key)) cacheBytes -= cache.get(key).size;
          cache.set(key, { result, size });
          cacheBytes += size;
          while (cacheBytes > maxCacheBytes || cache.size > maxCacheEntries) {
            const oldest = cache.keys().next().value;
            cacheBytes -= cache.get(oldest).size;
            cache.delete(oldest);
          }
        }
      }
      return result;
    } catch {
      return fail();
    }
  }
  async function redactValue(value, cacheKey = '') {
    let count = 0;
    const kinds = new Set();
    let failed = false;
    let current;
    try {
      current = await snapshot();
    } catch {
      return { value: UNAVAILABLE, count: 0, kinds: [], failed: true };
    }
    const visit = async (v, p) => {
      if (typeof v === 'string') {
        const r = await safe(v, p, current);
        count += r.count;
        r.kinds.forEach((k) => kinds.add(k));
        failed ||= !!r.failed;
        return r.text;
      }
      if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < v.length; i++) out.push(await visit(v[i], `${p}/${i}`));
        return out;
      }
      if (v && typeof v === 'object') {
        const out = Object.create(null);
        for (const [key, item] of Object.entries(v)) {
          const cleanKey = await visit(key, `${p}/key`);
          if (typeof item === 'string' && SENSITIVE_KEY.test(key)) {
            const encoded = await safe(`${key}=${JSON.stringify(item)}`, `${p}/${key}`, current);
            count += encoded.count;
            encoded.kinds.forEach((k) => kinds.add(k));
            failed ||= !!encoded.failed;
            try {
              out[cleanKey] = JSON.parse(encoded.text.slice(encoded.text.indexOf('=') + 1));
            } catch {
              out[cleanKey] = UNAVAILABLE;
              failed = true;
            }
          } else out[cleanKey] = await visit(item, `${p}/${key}`);
        }
        return out;
      }
      return v;
    };
    try {
      const result = await visit(value, cacheKey);
      return { value: result, count, kinds: [...kinds], ...(failed ? { failed: true } : {}) };
    } catch {
      return { value: UNAVAILABLE, count: 0, kinds: [], failed: true };
    }
  }
  return {
    redact: safe,
    redactValue,
    close() {
      closed = true;
      cache.clear();
      cacheBytes = 0;
      worker.close();
    },
  };
}
