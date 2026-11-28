import fs from 'node:fs';
import { inspectReferenceHeader, movePage, pagePath, publishReferenceFile, readReferenceIndex, rebuild } from './reference-index.js';
import { resolveAllowedMemoryPath } from './self-write.js';

export const PAGE_SOFT_LIMIT = 24 * 1024;
const THIRTY_DAYS = 30 * 86400_000;
const KINDS = ['projects', 'decisions'];
const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termPattern = term => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'u');
const old = (page, date) => Date.parse(date) - Date.parse(page.Updated) > THIRTY_DAYS;
const keysOf = page => [...new Set((page.Keys ?? page.Scope ?? '').split(/[,，;；]/).map(normalize).filter(Boolean))];
const pageFile = (root, relative) => resolveAllowedMemoryPath({ root, path: relative, allowed: value => value === relative }).target;
const read = (root, relative) => fs.readFileSync(pageFile(root, relative), 'utf8');

function indexes(root) {
  return KINDS.map(kind => ({ kind, ...readReferenceIndex(root, kind) }));
}

function pageCatalog(root, indexes) {
  return indexes.flatMap(({ kind, pages }) => pages.map(page => {
    const relative = `reference/${kind}/${page.file}`;
    return { ...page, kind, relative, keys: keysOf(page), text: read(root, relative) };
  }));
}

function candidateIdentifiers({ topic = '', text, source }) {
  const words = `${topic} ${text} ${source}`
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .match(/[#\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? [];
  return new Set(words.map(word => normalize(word.replace(/[.-]+$/, '')))
    .filter(word => /\d/.test(word) && (/[#\p{L}]/u.test(word) || /\d{3}/.test(word))
      && !/^(?:v\d|\d{1,2}[hms])$/.test(word)));
}

export function matchRuleLines(item, lines) {
  const patterns = [...candidateIdentifiers(item)].map(termPattern);
  if (!patterns.length) return [];
  return lines.filter(({ text }) => {
    const normalized = normalize(text);
    return patterns.some(pattern => pattern.test(normalized));
  });
}

export function candidatePages(pages) {
  const body = pages.map(page => normalize(page.text.replace(/^[\s\S]*?\r?\n\s*\r?\n/, '')));
  const hits = new Map();
  function counts(term) {
    if (!hits.has(term)) {
      const pattern = termPattern(term);
      const found = [];
      for (const [index, text] of body.entries()) {
        if (pattern.test(text)) found.push(index);
      }
      hits.set(term, found);
    }
    return hits.get(term);
  }
  return item => {
    const identifiers = candidateIdentifiers(item);
    const scores = new Map();
    function score(index, term, weight) {
      const row = scores.get(index) ?? { index, page: pages[index].relative, score: 0, terms: new Set() };
      row.score += weight;
      row.terms.add(term);
      scores.set(index, row);
    }
    for (const id of identifiers) {
      const matching = counts(id);
      for (const index of matching) score(index, id, 1 / matching.length);
    }
    return [...scores.values()].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 4)
      .map(row => `${row.page} (${[...row.terms].join(', ')})`);
  };
}

export function stageTwoInput(root, date, extracted) {
  const current = indexes(root);
  const findCandidates = candidatePages(pageCatalog(root, current));
  const groups = new Map();
  for (const entry of extracted) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  const lines = [`Date: ${date}`];
  for (const [group, entries] of groups) {
    lines.push(`\n## Group ${group}`);
    for (const { summary, items } of entries) {
      lines.push(summary);
      for (const item of items) lines.push(
        `- [${item.type}, owner=${item.owner}] ${item.topic}: ${item.text.replace(/\s*\n\s*/g, ' ')} (${item.source})` +
          (item.type === 'rule' ? ` c4_ids: ${JSON.stringify(item.c4_ids)}` : ''),
        `  Candidate pages: ${findCandidates(item).join('; ') || 'none'}`,
      );
    }
  }
  return [...lines, ...current.map(index => index.content)].join('\n');
}

export async function repairPageHeaders(root, invoke, mutate, failedRepairs) {
  await mutate(() => rebuild(root));
  const remaining = [];
  for (const { kind, malformed } of indexes(root)) for (const file of malformed) {
    const relative = `reference/${kind}/${file}`;
    if (failedRepairs.has(relative)) continue;
    if (!pagePath(relative)) {
      failedRepairs.add(relative);
      remaining.push(relative);
      continue;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = inspectReferenceHeader(read(root, relative), kind);
      if (!error) break;
      try {
        await invoke({
          instructions: 'Repair only the header of the named shared memory page. Read its header and use edit_memory to correct it. Preserve all other content.',
          input: `${relative}\n${error}\nStart with # <title>, then <!-- zylos:entry kind=${kind} -->, then - **Status:** <status> and - **Updated:** YYYY-MM-DD. Keep the other header fields on separate lines.`,
          page: relative,
        });
      } catch {
        // Recheck on-disk state even when a call exits after writing.
      }
    }
    if (inspectReferenceHeader(read(root, relative), kind).error) {
      failedRepairs.add(relative);
      remaining.push(relative);
    }
  }
  await mutate(() => rebuild(root));
  return remaining;
}

function pairsFor(pages) {
  const keyed = new Map();
  for (const page of pages) for (const key of page.keys) {
    const id = `${page.kind}/${key}`;
    if (!keyed.has(id)) keyed.set(id, []);
    keyed.get(id).push(page.relative);
  }
  const pairs = new Map();
  for (const [id, names] of keyed) {
    if (names.length > 3) continue;
    const key = id.slice(id.indexOf('/') + 1);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const pair = [names[i], names[j]].sort().join(' and ');
      if (!pairs.has(pair)) pairs.set(pair, []);
      pairs.get(pair).push(key);
    }
  }
  return [...pairs].map(([pair, keys]) => `- ${pair} (shared keys: ${keys.join(', ')})`);
}

function splitHeader(text) {
  const blank = /\r?\n[ \t]*\r?\n/.exec(text);
  return blank ? { header: text.slice(0, blank.index), body: text.slice(blank.index + blank[0].length) } : { header: text, body: '' };
}

function largePages(root) {
  return pageCatalog(root, indexes(root)).map(page => ({ ...page, bytes: Buffer.byteLength(page.text) }))
    .filter(page => page.bytes > PAGE_SOFT_LIMIT && pagePath(page.relative))
    .sort((a, b) => b.bytes - a.bytes || a.relative.localeCompare(b.relative));
}

// Bodies over SPLIT_LIMIT are condensed in parts of at most PART_LIMIT: some runtimes cut the middle of a very long input.
const SPLIT_LIMIT = 150 * 1024;
const PART_LIMIT = 120 * 1024;
const ENTRY_START = /^(#{1,6} |[-*+] |\d+[.)] )/;

/** Split text at entry starts (headings and top-level list items) into parts of at most PART_LIMIT; an entry longer than a part is cut at line ends. */
function splitBody(text) {
  const blocks = [];
  for (const line of text.split('\n')) {
    if (!blocks.length || (ENTRY_START.test(line) && blocks.at(-1).length)) blocks.push([]);
    blocks.at(-1).push(line);
  }
  // Running byte counts: each line costs its bytes plus one for the joining newline.
  const parts = [{ lines: [], bytes: -1 }];
  const add = line => { parts.at(-1).lines.push(line); parts.at(-1).bytes += Buffer.byteLength(line) + 1; };
  for (const lines of blocks) {
    const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    if (parts.at(-1).lines.length && parts.at(-1).bytes + bytes > PART_LIMIT) parts.push({ lines: [], bytes: -1 });
    for (const line of lines) {
      if (parts.at(-1).lines.length && parts.at(-1).bytes + Buffer.byteLength(line) + 1 > PART_LIMIT) parts.push({ lines: [], bytes: -1 });
      add(line);
    }
  }
  return parts.map(part => part.lines.join('\n'));
}

function bodyCheck(limit) {
  return text => {
    const bytes = Buffer.byteLength(text.trim());
    if (bytes > limit) throw new Error(`body is ${bytes} bytes; it must be at most ${limit} bytes`);
    if (!text.trim().startsWith('## ')) throw new Error('body must be Markdown itself, starting with a "## " heading');
    return text.trim();
  };
}

/** Condense one page: the model rewrites the body from the inlined text; the script keeps the header and writes it back. */
async function condensePage({ root, date, relative, condense, mutate }) {
  // Read again: a live session may have edited, moved or shortened the page while earlier pages were condensed.
  let text;
  try { text = read(root, relative); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (Buffer.byteLength(text) <= PAGE_SOFT_LIMIT) return false;
  const page = { relative, text };
  const { header, body } = splitHeader(text);
  const budget = PAGE_SOFT_LIMIT - Buffer.byteLength(header) - 3;
  await mutate(() => {
    const archive = pageFile(root, `archive/dreaming/${date}/${page.relative}`);
    if (!fs.existsSync(archive)) publishReferenceFile(archive, page.text, true);
  });
  const lead = [`Date: ${date}`, `Page: ${page.relative}`];
  const pageHeader = ['', '## Header (kept as is by the script)', header, ''];
  let content = ['## Body', body];
  let condensed;
  try {
    // Each part is condensed to notes, which have only a target size. Notes still too long for one call are
    // split and condensed again; the final call rewrites the body from the notes in page order.
    let text = body, source = 'Body';
    while (Buffer.byteLength(text) > SPLIT_LIMIT) {
      const parts = splitBody(text);
      const target = Math.floor(SPLIT_LIMIT / parts.length);
      const notes = [];
      for (const [index, part] of parts.entries()) {
        const label = `${source} part ${index + 1} of ${parts.length}`;
        try {
          notes.push(await condense([...lead, `${label}; write notes for this part only`,
            `Notes target: about ${target} bytes in UTF-8 (a Chinese character takes 3 bytes)`,
            ...pageHeader, `## ${label}`, part].join('\n'), bodyCheck(Infinity)));
        } catch (error) { throw new Error(`${label}: ${error.message}`); }
      }
      const joined = notes.map((note, index) => `### Notes on part ${index + 1} of ${parts.length}\n\n${note}`).join('\n\n');
      if (Buffer.byteLength(joined) >= Buffer.byteLength(text)) throw new Error('notes on the parts were not shorter than the text');
      text = joined;
      source = 'Notes';
      content = [`## Notes on the body, in page order (the body was ${Buffer.byteLength(body)} bytes)`, text];
    }
    condensed = await condense([...lead, `Body size limit: ${budget} bytes in UTF-8 (a Chinese character takes 3 bytes)`,
      ...pageHeader, ...content].join('\n'), bodyCheck(budget));
  } catch (error) { return `Unable to condense ${page.relative}: ${error.message}`; }
  let changed = false;
  await mutate(() => {
    let current = null;
    try { current = read(root, page.relative); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== page.text) { changed = true; return; }
    publishReferenceFile(pageFile(root, page.relative), `${header}\n\n${condensed}\n`);
  });
  return changed ? `Unable to condense ${page.relative}: the page changed while it was being condensed` : null;
}

export async function tidyReference({ root, date, call, condense, repair, mutate, stats = { merged: 0, archived: 0, condensed: 0, condenseFailed: 0 } }) {
  const starting = pageCatalog(root, indexes(root));
  const stale = starting.filter(page => page.Status === 'active' && old(page, date));
  const errors = [];
  const input = [
    ...indexes(root).map(index => index.content),
    '## Active pages older than 30 days',
    ...stale.map(page => `- ${page.relative} (Updated ${page.Updated})`),
    '## Candidate pairs',
    ...pairsFor(starting),
  ].join('\n');
  let result;
  try { result = await call(input); }
  catch (error) { errors.push(`Weekly memory tidy failed: ${error.message}`); }
  errors.push(...(await repair()).map(file => `Unparsable reference header: ${file}`));
  await mutate(() => {
    for (const { keep, archive } of result?.merged ?? []) {
      if (!pagePath(keep) || !pagePath(archive) || keep === archive || keep.split('/')[1] !== archive.split('/')[1] ||
          !fs.existsSync(pageFile(root, keep)) || !fs.existsSync(pageFile(root, archive))) {
        errors.push(`Invalid merged page pair: ${keep} / ${archive}`);
        continue;
      }
      const file = pageFile(root, archive);
      const pointer = `Merged into: ${keep}`;
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (!text.split('\n').includes(pointer)) publishReferenceFile(file, `${text.trimEnd()}\n\n${pointer}\n`);
        movePage(root, archive, false, { rebuildIndex: false });
        stats.merged++;
        stats.archived++;
      } catch (error) {
        errors.push(`Unable to archive ${archive}: ${error.code ?? error.message}`);
      }
    }
    for (const { kind, pages } of indexes(root)) for (const page of pages) {
      if (!['completed', 'abandoned'].includes(page.Status) || !old(page, date)) continue;
      const relative = `reference/${kind}/${page.file}`;
      if (!pagePath(relative)) continue;
      try {
        movePage(root, relative, false, { rebuildIndex: false });
        stats.archived++;
      } catch (error) { errors.push(`Unable to archive ${relative}: ${error.code ?? error.message}`); }
    }
    rebuild(root);
  });
  // Pages are measured after merging and archiving, largest first, one call each.
  for (const { relative } of largePages(root)) {
    // A page that vanished or shrank before processing is skipped.
    let outcome;
    try { outcome = await condensePage({ root, date, relative, condense, mutate }); }
    finally {
      if (outcome === null) stats.condensed++;
      else if (outcome !== false) stats.condenseFailed++;
    }
    if (outcome) errors.push(outcome);
  }
  return errors;
}
