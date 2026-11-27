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

export function candidatePages(pages) {
  const body = pages.map(page => normalize(page.text.replace(/^[\s\S]*?\r?\n\s*\r?\n/, '')));
  const keyed = new Map(), hits = new Map();
  for (const [index, page] of pages.entries()) for (const key of page.keys) {
    if (!keyed.has(key)) keyed.set(key, []);
    keyed.get(key).push(index);
  }
  function counts(term) {
    if (!hits.has(term)) {
      const pattern = termPattern(term);
      const found = [];
      for (const [index, text] of body.entries()) {
        if (pattern.test(text)) found.push(index);
        if (found.length > 3) break;
      }
      hits.set(term, found);
    }
    return hits.get(term);
  }
  return item => {
    const text = normalize(`${item.topic} ${item.text} ${item.source}`);
    const identifiers = (`${item.topic} ${item.text} ${item.source}`).replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
      .match(/[#\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
    const scores = new Map();
    function score(index, term, weight) {
      const row = scores.get(index) ?? { page: pages[index].relative, score: 0, terms: new Set() };
      row.score += weight;
      row.terms.add(term);
      scores.set(index, row);
    }
    for (const [key, matching] of keyed) {
      if (!termPattern(key).test(text) || matching.length > 3 || counts(key).length > 3) continue;
      for (const index of matching) score(index, key, 1 / matching.length);
    }
    for (const id of new Set(identifiers.filter(word => /\d/.test(word)).map(normalize))) {
      const matching = counts(id);
      if (matching.length <= 3) for (const index of matching) score(index, id, 0.5 / matching.length);
    }
    return [...scores.values()].sort((a, b) => b.score - a.score || a.page.localeCompare(b.page)).slice(0, 4)
      .map(row => `${row.page} (${[...row.terms].join(', ')})`);
  };
}

export function stageTwoInput(root, date, batches) {
  const current = indexes(root);
  const findCandidates = candidatePages(pageCatalog(root, current));
  const groups = new Map();
  for (const batch of batches) for (const entry of batch.groups) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  const lines = [`Date: ${date}`];
  for (const [group, entries] of groups) {
    lines.push(`\n## Group ${group}`);
    for (const { summary, items } of entries) {
      lines.push(summary);
      for (const item of items) lines.push(
        `- [${item.type}, owner=${item.owner}] ${item.topic}: ${item.text.replace(/\s*\n\s*/g, ' ')} (${item.source})`,
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

/** Split a body at entry starts (headings and top-level list items) into parts of similar size, each at most PART_LIMIT where entries allow. */
export function splitBody(body) {
  const blocks = [];
  for (const line of body.split('\n')) {
    if (!blocks.length || (ENTRY_START.test(line) && blocks.at(-1).length)) blocks.push([]);
    blocks.at(-1).push(line);
  }
  const texts = blocks.flatMap(lines => {
    const text = lines.join('\n');
    if (Buffer.byteLength(text) <= PART_LIMIT) return [text];
    // An entry longer than a part is cut at line ends.
    const pieces = [[]];
    for (const line of lines) {
      if (pieces.at(-1).length && Buffer.byteLength([...pieces.at(-1), line].join('\n')) > PART_LIMIT) pieces.push([]);
      pieces.at(-1).push(line);
    }
    return pieces.map(piece => piece.join('\n'));
  });
  const total = Buffer.byteLength(body);
  const target = total / Math.ceil(total / PART_LIMIT);
  const parts = [''];
  for (const text of texts) {
    const current = parts.at(-1);
    const joined = current ? `${current}\n${text}` : text;
    if (current && (Buffer.byteLength(joined) > PART_LIMIT || Buffer.byteLength(current) >= target)) parts.push(text);
    else parts[parts.length - 1] = joined;
  }
  return parts;
}

function bodyCheck(limit) {
  return text => {
    const bytes = Buffer.byteLength(text.trim());
    if (bytes > limit) throw new Error(`body is ${bytes} bytes; it must be at most ${limit} bytes`);
    if (/<!-- zylos:entry/.test(text)) throw new Error('return only the body, without the page header');
    if (!text.trim().startsWith('## ')) throw new Error('body must be Markdown itself, starting with a "## " heading');
    return text.trim();
  };
}

/** Condense one page: the model rewrites the body from the inlined text; the script keeps the header and writes it back. */
async function condensePage({ root, date, page, condense, mutate }) {
  const { header, body } = splitHeader(page.text);
  const budget = PAGE_SOFT_LIMIT - Buffer.byteLength(header) - 3;
  if (budget < 1024) return `Unable to condense ${page.relative}: its header alone is near the size limit`;
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
    let text = body;
    while (Buffer.byteLength(text) > SPLIT_LIMIT) {
      const parts = splitBody(text);
      const target = Math.floor(SPLIT_LIMIT / parts.length);
      const notes = [];
      for (const [index, part] of parts.entries()) {
        const label = `part ${index + 1} of ${parts.length}`;
        try {
          notes.push(await condense([...lead, `Body ${label}; write notes for this part only`,
            `Notes target: about ${target} bytes in UTF-8 (a Chinese character takes 3 bytes)`,
            ...pageHeader, `## Body ${label}`, part].join('\n'), bodyCheck(Infinity)));
        } catch (error) { throw new Error(`${label}: ${error.message}`); }
      }
      const joined = notes.map((note, index) => `### Notes on part ${index + 1} of ${parts.length}\n\n${note}`).join('\n\n');
      if (Buffer.byteLength(joined) >= Buffer.byteLength(text)) throw new Error('notes on the parts were not shorter than the text');
      text = joined;
      content = [`## Notes on the body, in page order (the body was ${Buffer.byteLength(body)} bytes)`, text];
    }
    condensed = await condense([...lead, `Body size limit: ${budget} bytes in UTF-8 (a Chinese character takes 3 bytes)`,
      ...pageHeader, ...content].join('\n'), bodyCheck(budget));
  } catch (error) { return `Unable to condense ${page.relative}: ${error.message}`; }
  let changed = false;
  await mutate(() => {
    if (read(root, page.relative) !== page.text) { changed = true; return; }
    publishReferenceFile(pageFile(root, page.relative), `${header}\n\n${condensed}\n`);
  });
  return changed ? `Unable to condense ${page.relative}: the page changed while it was being condensed` : null;
}

export async function tidyReference({ root, date, call, condense, repair, mutate }) {
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
      } catch (error) {
        errors.push(`Unable to archive ${archive}: ${error.code ?? error.message}`);
      }
    }
    for (const { kind, pages } of indexes(root)) for (const page of pages) {
      if (!['completed', 'abandoned'].includes(page.Status) || !old(page, date)) continue;
      const relative = `reference/${kind}/${page.file}`;
      if (!pagePath(relative)) continue;
      try { movePage(root, relative, false, { rebuildIndex: false }); }
      catch (error) { errors.push(`Unable to archive ${relative}: ${error.code ?? error.message}`); }
    }
    rebuild(root);
  });
  // Pages are measured after merging and archiving, largest first, one call each.
  for (const page of largePages(root)) {
    const error = await condensePage({ root, date, page, condense, mutate });
    if (error) errors.push(error);
  }
  await mutate(() => rebuild(root));
  return errors;
}
