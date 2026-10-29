// Structural credentials; values are filtered to avoid treating source code as secrets.
export const SENSITIVE_KEY =
  /(?:password|passwd|secret|(?:^|[_-])(?:token|pwd)(?:$|[_-])|[_-]key(?:$|[_-])|(?:api|access|session|client|private|signing|encryption)Key|(?:access|auth|session|refresh|bearer)Token|credential|authorization|cookie)/i;
export function isCredentialValue(value) {
  const v = value.trim();
  return (
    v.length > 0 &&
    !/^(?:\d+|true|false|null|undefined|none|redacted|placeholder|example|test|dummy|changeme|your[_ -].*|\*+|<.*>)$/i.test(
      v,
    ) &&
    !/^\$[A-Za-z_]\w*$/.test(v) &&
    !/\$\{|\$\(|\{\{|\b(?:process\.env|config\.|options\.|this\.|os\.environ)/.test(v) &&
    !/^(?:\.{0,2}\/|~\/|[A-Z]:\\)/i.test(v) &&
    !/[(){}]|=>/.test(v)
  );
}
export function keynameSpans(text) {
  const spans = [];
  const add = (start, value, label) => {
    if (isCredentialValue(value))
      spans.push({ start, end: start + value.length, ruleId: 'structure', label });
  };
  const pairs =
    /(?<![\w.-])(?:["']?)([A-Za-z_][\w.-]*)(?:["']?)\s*[:=]\s*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^\s,;\r\n]+))/g;
  for (const m of text.matchAll(pairs)) {
    if (!SENSITIVE_KEY.test(m[1])) continue;
    const value = m[2] ?? m[3] ?? m[4];
    const start = m.index + m[0].lastIndexOf(value);
    if (/authorization/i.test(m[1]) && /^(?:Bearer|Basic)(?:\s|$)/i.test(value)) {
      const scheme = /^(?:Bearer|Basic)\s*/i.exec(value)[0];
      if (value.length > scheme.length)
        add(start + scheme.length, value.slice(scheme.length), 'Authorization');
    } else add(start, value, 'Credential');
  }
  for (const m of text.matchAll(
    /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*((?:Bearer|Basic)\s+)?([^\r\n"']+)/gi,
  )) {
    add(m.index + m[0].length - m[3].length, m[3], m[1]);
  }
  for (const m of text.matchAll(/(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\/([^\s/@:]+):([^\s/@]+)@/gi)) {
    const start = m.index + m[0].indexOf('://') + 3;
    spans.push({
      start,
      end: m.index + m[0].length - 1,
      ruleId: 'url-userinfo',
      label: 'URL credentials',
    });
  }
  for (const m of text.matchAll(/[?&]([^=&#?\s]+)=([^&#\s"']+)/g)) {
    let key = m[1];
    try {
      key = decodeURIComponent(key);
    } catch {
      /* Keep the original malformed parameter name. */
    }
    if (SENSITIVE_KEY.test(key)) add(m.index + m[0].length - m[2].length, m[2], 'URL credential');
  }
  return spans;
}
