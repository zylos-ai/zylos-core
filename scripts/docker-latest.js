import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const number = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${number}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionTag = new RegExp(`^v(${number})\\.(${number})\\.(${number})` +
  `(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function parseTag(tag) {
  if (typeof tag !== 'string') return null;
  const match = versionTag.exec(tag);
  if (!match || match[0] !== tag) return null;
  return { parts: match.slice(1, 4).map(BigInt), prerelease: match[4] !== undefined };
}

export function isLatestStableTag(currentTag, tags) {
  const current = parseTag(currentTag);
  if (!current || current.prerelease || !Array.isArray(tags) || !tags.includes(currentTag)) return false;
  return !tags.some(tag => {
    const candidate = parseTag(tag);
    if (!candidate || candidate.prerelease) return false;
    // Build metadata is absent from parts, so equal precedence does not disqualify a tag.
    for (let i = 0; i < 3; i++) {
      if (candidate.parts[i] !== current.parts[i]) return candidate.parts[i] > current.parts[i];
    }
    return false;
  });
}

export function latestFromGit(ref) {
  if (!ref?.startsWith('refs/tags/')) return false;
  try {
    const output = execFileSync('git', ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
    const tags = output.split(/\r?\n/).filter(Boolean);
    return isLatestStableTag(ref.slice('refs/tags/'.length), tags);
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `latest=${latestFromGit(process.env.GITHUB_REF)}\n`);
}
