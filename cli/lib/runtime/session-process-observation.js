import fs from 'node:fs/promises';
import path from 'node:path';

const missing = error => ['ENOENT', 'ESRCH'].includes(error.code);
function parseStat(text, pid) {
  const end = text.lastIndexOf(')');
  if (!text.startsWith(`${pid} (`) || end < 0) throw new Error('Malformed process identity');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (!/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[19])) throw new Error('Incomplete process identity');
  return { start: fields[19], zombie: fields[0] === 'Z' };
}
const nulEntries = bytes => {
  const values = bytes.toString().split('\0');
  if (values.at(-1) === '') values.pop();
  return values;
};

/** Internal observation boundary. Unavailable fields never prove process exit.
 * Backends must supply a stable incarnation and complete exec image; a platform
 * without that capability remains uncertain, never a successful empty snapshot.
 */
export async function readProcessImage(pid, { platform = process.platform, procRoot = '/proc', filesystem = fs } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return { uncertain: true };
  const dir = path.join(procRoot, String(pid));
  const absentIdentity = async error => {
    if (!missing(error)) return false;
    try { return (await filesystem.stat(procRoot)).isDirectory(); }
    catch { return false; }
  };
  const readIdentity = async () => parseStat(await filesystem.readFile(path.join(dir, 'stat'), 'utf8'), pid);
  let before;
  try { before = await readIdentity(); }
  catch (error) { return await absentIdentity(error) ? { gone: true } : { uncertain: true }; }
  if (before.zombie) return { gone: true };
  let image;
  try {
    const [exe, argv, env, cwd] = await Promise.all([
      filesystem.readlink(path.join(dir, 'exe')),
      filesystem.readFile(path.join(dir, 'cmdline')),
      filesystem.readFile(path.join(dir, 'environ')),
      filesystem.readlink(path.join(dir, 'cwd')),
    ]);
    image = { exe, cwd, argv: nulEntries(argv), env: nulEntries(env), start: before.start };
  } catch { /* Recheck the original process before classifying an incomplete read. */ }
  let after;
  try { after = await readIdentity(); }
  catch (error) { return await absentIdentity(error) ? { gone: true, start: before.start } : { uncertain: true, start: before.start }; }
  if (after.start !== before.start) return { uncertain: true, start: before.start };
  if (after.zombie) return { gone: true, start: before.start };
  return image || { uncertain: true, start: before.start };
}
