import fs from 'node:fs';
import { inspectReferenceHeader, movePage, pagePath, publishReferenceFile, readReferenceIndex, rebuild } from './reference-index.js';
import { resolveAllowedMemoryPath } from './self-write.js';

export const PAGE_SOFT_LIMIT = 24 * 1024;
const COMPRESSION_BATCH_SIZE = 5;
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

export async function tidyReference({ root, date, call, repair, mutate }) {
  const starting = pageCatalog(root, indexes(root));
  const large = starting.map(page => ({ ...page, bytes: Buffer.byteLength(page.text) }))
    .filter(page => page.bytes > PAGE_SOFT_LIMIT && pagePath(page.relative))
    .sort((a, b) => b.bytes - a.bytes || a.relative.localeCompare(b.relative));
  const stale = starting.filter(page => page.Status === 'active' && old(page, date));
  const pairs = pairsFor(starting);
  const errors = [];
  for (let offset = 0, first = true; first || offset < large.length; first = false) {
    const batch = [];
    while (offset < large.length && batch.length < COMPRESSION_BATCH_SIZE) {
      const page = large[offset++];
      if (fs.existsSync(pageFile(root, page.relative))) batch.push(page);
    }
    if (!first && !batch.length) break;
    const input = [
      ...indexes(root).map(index => index.content),
      '## Active pages older than 30 days',
      ...(first ? stale.map(page => `- ${page.relative} (Updated ${page.Updated})`) : []),
      '## Large pages',
      ...batch.map(page => `- ${page.relative} (${page.bytes} bytes)`),
      '## Candidate pairs',
      ...(first ? pairs : []),
    ].join('\n');
    let result;
    let failed = false;
    try {
      await mutate(() => {
        for (const page of batch) {
          const archive = pageFile(root, `archive/dreaming/${date}/${page.relative}`);
          if (!fs.existsSync(archive)) publishReferenceFile(archive, read(root, page.relative), true);
        }
      });
      result = await call(input);
    } catch (error) {
      failed = true;
      errors.push(`Weekly memory tidy failed: ${error.message}`);
    }
    errors.push(...(await repair()).map(file => `Unparsable reference header: ${file}`));
    if (first) await mutate(() => {
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
    if (failed) break;

  }
  return errors;
}
