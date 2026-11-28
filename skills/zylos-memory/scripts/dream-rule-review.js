import fs from 'node:fs';
import path from 'node:path';
import { dreamMessageText } from './dream-history.js';
import { matchRuleLines } from './dream-pages.js';

const MAX_MESSAGE_CHARS = 4000;
const DESTINATIONS = {
  rules: 'ZYLOS.md or memory/session-groups/<group>/rules.md',
  preferences: 'memory/reference/preferences.md',
  skill: 'Create or update a skill',
};

function readIfPresent(file, read) {
  try { return read(file); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return null;
  }
}

function existingRuleLines(root) {
  const groups = 'memory/session-groups';
  const skills = '.claude/skills';
  const entries = directory => readIfPresent(path.join(root, directory), fs.readdirSync)?.sort() ?? [];
  const files = [
    'ZYLOS.md',
    ...entries(groups).map(group => path.join(groups, group, 'rules.md')),
    'memory/reference/preferences.md',
    ...entries(skills).map(skill => path.join(skills, skill, 'SKILL.md')),
  ];
  return files.flatMap(file => {
    const text = readIfPresent(path.join(root, file), target => fs.readFileSync(target, 'utf8'));
    return text?.split(/\r?\n/).map((line, index) => ({ file, line: index + 1, text: line })) ?? [];
  });
}

export function ruleReviewMaterial(root, candidates, extracted, conversations) {
  // The merge may cite only rule evidence from completed, group-validated extractions.
  const allowed = new Set(extracted.flatMap(({ items }) =>
    items.filter(item => item.type === 'rule').flatMap(item => item.c4_ids)));
  const rows = new Map(conversations.flatMap(({ group, rows }) =>
    rows.filter(row => allowed.has(row.id)).map(row => [row.id, { group, row }])));
  const ruleLines = existingRuleLines(root);
  return candidates.map(candidate => {
    const requested = [...new Set(candidate.c4_ids)];
    const c4_ids = requested.filter(id => rows.has(id));
    const originalMessages = c4_ids.map(id => {
      const { group, row } = rows.get(id);
      const chars = Array.from(dreamMessageText(row));
      const truncated = chars.length > MAX_MESSAGE_CHARS;
      return { id, group, direction: row.direction, text: chars.slice(0, MAX_MESSAGE_CHARS).join(''), truncated };
    });
    const matches = matchRuleLines({ ...candidate, source: [candidate.source, ...c4_ids].join(' ') }, ruleLines);
    return {
      ...candidate,
      destination: DESTINATIONS[candidate.destination],
      c4_ids,
      originalMessages,
      ...(!c4_ids.length || c4_ids.length < requested.length ? { sourceNote: 'Original message unavailable' } : {}),
      matchingRuleLines: matches.length ? matches : 'none',
    };
  });
}
