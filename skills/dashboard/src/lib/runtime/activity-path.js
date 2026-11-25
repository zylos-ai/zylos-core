const BASENAME = /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,79}$/u;
const SECRET_NAME = /^(?:sk-|xox[a-z]-|gh[pousr]_|github_pat_|AKIA|eyJ)/i;

function pathParts(value) {
  return typeof value === 'string' && !/[:@?\s#$=`"'\\]/u.test(value) ? value.split('/') : [];
}

export function safeBasename(value) {
  const name = pathParts(value).at(-1);
  return name && BASENAME.test(name) && !SECRET_NAME.test(name) ? name : null;
}

export function skillNameFromPath(value) {
  const parts = pathParts(value);
  return parts.at(-3) === 'skills' && parts.at(-1) === 'SKILL.md' ? safeBasename(parts.at(-2)) : null;
}
