// Test-only source mutations, scoped to this loader's child process.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/scheduler/scripts/saved-session-group.js') || !process.env.P08_GROUP_MUTANT) return result;
  let source = String(result.source);
  const anchor = '  const group = env.ZYLOS_SESSION_GROUP;';
  if (source.split(anchor).length !== 2) throw new Error('Saved-group mutation anchor changed');
  if (process.env.P08_GROUP_MUTANT === 'latest') {
    source = source.replace('import { getComponentByNamespace }', 'import { getComponentByNamespace, getRecentConversations }');
    source = source.replace(anchor, '  const group = env.ZYLOS_SESSION_GROUP ?? getRecentConversations(1)[0]?.session_group;');
  } else if (process.env.P08_GROUP_MUTANT === 'tmux') {
    source = "import { execFileSync } from 'node:child_process';\n" + source;
    source = source.replace(anchor, "  const group = env.ZYLOS_SESSION_GROUP ?? execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' }).trim();");
  } else throw new Error('Unknown saved-group mutation');
  return { ...result, source };
}
