import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGroupDeletionFixture } from './group-deletion-fixture.js';
import { Store } from '../../skills/dashboard/src/lib/store.js';
import { ChatConversations } from '../../skills/dashboard/src/lib/chat/conversations.js';
import { createGroupDeletionBridge, createGroupDeletionRoutes } from '../../skills/dashboard/src/lib/workbench/group-deletion.js';
import { groupDeletionCliPath } from '../../cli/lib/group-delete.js';
import { sendHtml, sendJson, serveStatic } from '../../skills/dashboard/src/lib/http.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inside = (root, file) => file.startsWith(root + path.sep);
const existsNoFollow = file => {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
const rows = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

/** Prepared artifacts are a private, read-only copy of a real historical run.
 * No live transcript paths or credentials are accepted by this browser case. */
function copyPreparedSession(prepared, f) {
  const sourceRoot = fs.realpathSync(prepared);
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8'));
  for (const key of ['sessionId', 'project', 'agentId']) {
    assert.match(manifest[key], /^[A-Za-z0-9._-]+$/);
    assert.ok(!['.', '..'].includes(manifest[key]), 'Artifact identifiers cannot name a parent directory');
  }
  const source = key => {
    const file = path.resolve(sourceRoot, manifest[key]);
    assert.ok(inside(sourceRoot, file));
    if (key !== 'taskLink') {
      assert.equal(fs.lstatSync(file).isFile(), true, 'Prepared transcripts must be regular files');
      assert.equal(fs.realpathSync(file), file, 'Prepared transcripts and their parents cannot redirect outside the copy');
    }
    return file;
  };
  const mainSource = source('main'), childSource = source('child'), linkSource = source('taskLink');
  assert.equal(sha(mainSource), manifest.mainSha256); assert.equal(sha(childSource), manifest.childSha256);
  assert.equal(fs.lstatSync(linkSource).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(linkSource), childSource);
  const parentRows = rows(mainSource), childRows = rows(childSource);
  const agentCalls = parentRows.flatMap(row => Array.isArray(row.message?.content) ? row.message.content : [])
    .filter(block => block.type === 'tool_use' && ['Agent', 'Task'].includes(block.name)).length;
  const childReplies = childRows.filter(row => row.type === 'assistant' && row.isSidechain === true && row.message?.usage).length;
  assert.ok(agentCalls > 0, 'The prepared parent really invoked a subagent');
  assert.ok(childReplies > 0, 'The prepared child really contains model responses with usage');
  assert.ok(childRows.some(row => row.agentId === manifest.agentId));
  const project = path.join(f.homeDir, '.claude/projects', manifest.project);
  const main = path.join(project, `${manifest.sessionId}.jsonl`);
  const child = path.join(project, manifest.sessionId, 'subagents', `agent-${manifest.agentId}.jsonl`);
  write(main, fs.readFileSync(mainSource)); write(child, fs.readFileSync(childSource));
  const tempRoot = path.join(f.env.TMPDIR, `claude-${process.getuid()}`);
  const tempDirectory = path.join(tempRoot, manifest.project, manifest.sessionId);
  assert.ok(inside(path.join(f.homeDir, '.claude/projects'), main));
  assert.ok(inside(path.join(f.homeDir, '.claude/projects'), child));
  assert.ok(inside(tempRoot, tempDirectory));
  const link = path.join(tempDirectory, 'tasks', `${manifest.agentId}.output`);
  fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(child, link);
  assert.equal(sha(main), manifest.mainSha256); assert.equal(sha(child), manifest.childSha256);
  return { manifest, sourceRoot, mainSource, childSource, main, child, link, tempDirectory, agentCalls, childReplies };
}

export async function runRealSessionDeletionBrowser(t) {
  const prepared = process.env.ZYLOS_GROUP_DELETION_PREPARED_SESSION;
  assert.ok(prepared && path.isAbsolute(prepared), 'An explicit private prepared history copy is required');
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  assert.ok(evidence && path.isAbsolute(evidence)); fs.mkdirSync(evidence, { recursive: true });
  const group = 'dashboard:real-subagent-copy', localId = 'real-subagent-copy';
  const f = await createGroupDeletionFixture(t, { group });
  await f.sandbox.runCase(async () => {
    console.log('Real historical deletion isolation:', JSON.stringify(f.sandbox.assertIsolation({ env: f.env })));
    const copied = copyPreparedSession(prepared, f);
    const skills = path.join(f.root, '.claude/skills'); fs.mkdirSync(skills, { recursive: true });
    for (const name of ['dashboard', 'comm-bridge']) fs.symlinkSync(path.join(repo, 'skills', name), path.join(skills, name), 'dir');
    f.store.registerChannelNamespace('dashboard', 'dashboard');
    const input = f.store.insertConversation('in', 'dashboard', localId, 'Historical subagent acceptance copy', { groupName: localId });
    f.store.claimConversation(input.id); f.store.markDelivered(input.id, { sessionId: copied.manifest.sessionId });
    f.store.insertConversation('out', 'dashboard', localId, 'A real historical child completed', { groupName: localId });
    const dashboard = new Store(f.sandbox.paths.dashboardDb); f.sandbox.addCleanup(() => dashboard.close());
    const conversations = new ChatConversations({ store: dashboard });
    conversations.registerExistingGroup(group, { _open: () => f.database });
    conversations.rename(localId, '真实子代理历史副本 / Real subagent history copy');
    dashboard.insertUsageTranscript({ transcript_path: copied.main, runtime: 'claude', session_group: group,
      session_id: copied.manifest.sessionId, run_id: 'historical-copy' }, new Date().toISOString());
    dashboard.insertUsageTranscript({ transcript_path: copied.child, runtime: 'claude', session_group: group,
      session_id: copied.manifest.sessionId, run_id: 'historical-copy', parent_path: copied.main }, new Date().toISOString());
    const cliResults = [], requests = [];
    const core = createGroupDeletionBridge({ zylosDir: f.root, env: f.env,
      loadCoreModule: async () => ({ groupDeletionCliPath }),
      execute: async (binary, args, options) => {
        const child = f.sandbox.startChild(binary, args, { env: options.env, timeoutMs: options.timeout });
        child.stdin.end(); const result = await child.completion;
        const value = JSON.parse(result.stdout.trim()); cliResults.push({ preview: args.includes('--preview'), code: result.code, value });
        return result;
      } });
    const deletion = createGroupDeletionRoutes({ conversations, core, config: { zylosDir: f.root, auth: { password: 'isolated-fixture' } },
      auth: { enabled: true, resolveAuthContext: req => req.headers.cookie?.includes('deletion_fixture=owner')
        ? { kind: 'cookie', scope: 'admin', principalId: 'fixture-owner' } : null } });
    const publicDir = path.join(repo, 'skills/dashboard/public');
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname.endsWith('/deletion') || req.method === 'DELETE') requests.push({ method: req.method, pathname: url.pathname });
        if (await deletion(req, res, url)) return;
        if (url.pathname === '/api/chat/conversations') {
          const value = conversations.findByGroup(group);
          sendJson(res, 200, { items: value ? [{ ...value, stamp: Date.now() }] : [], nextCursor: null, tz: 'UTC', deletionAllowed: true }); return;
        }
        if (/^\/api\/chat\/conversations\/[^/]+$/.test(url.pathname)) {
          sendJson(res, 200, { conversation: conversations.findByGroup(group), stored: true }); return;
        }
        if (/^\/api\/chat\/conversations\/[^/]+\/(?:messages|questions|activity|status)$/.test(url.pathname)) {
          sendJson(res, 200, { items: [], rounds: [], nextCursor: null, afterCursor: null, tz: 'UTC' }); return;
        }
        if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
        if (url.pathname.startsWith('/api/')) {
          const value = workbenchAnswer(url, Date.now()); sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
        }
        if (['/', '/chat'].includes(url.pathname)) {
          sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
            .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin')); return;
        }
        if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
      } catch (error) { sendJson(res, 500, { error: error.code ?? error.message }); }
    });
    const base = await f.sandbox.startHttp(server);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, env: f.sandbox.env, headless: true,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    f.sandbox.addCleanup(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 }, locale: 'zh-CN' });
    f.sandbox.addCleanup(() => context.close());
    await context.addCookies([{ name: 'deletion_fixture', value: 'owner', url: base }]);
    await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem('zylos-dashboard-locale', 'zh'); localStorage.setItem('zylos-dashboard-theme', 'light');
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => { if (errors.length < 3) errors.push(error.message); });
    await page.goto(base + '/chat'); await page.locator('.conversation-delete:visible').first().waitFor();
    await page.screenshot({ path: path.join(evidence, '1280-before.png') });
    await page.locator('.conversation-delete:visible').first().click();
    const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
    assert.equal(cliResults.length, 1); assert.equal(cliResults[0].preview, true); assert.equal(cliResults[0].value.ok, true);
    assert.ok(cliResults[0].value.files >= 3, 'Preview includes the copied parent, child and task output symlink');
    await page.screenshot({ path: path.join(evidence, '1280-confirm.png') });
    await dialog.locator('button').last().click();
    await page.waitForFunction(() => document.querySelectorAll('.conversation-delete').length === 0);
    await f.waitFor(() => cliResults.some(item => !item.preview && item.value.ok && item.value.pending === false), 'The real Core deletion CLI must complete', 20000);
    const completed = cliResults.findLast(item => !item.preview && item.value.ok && item.value.pending === false).value;
    for (const file of [copied.main, copied.child, copied.link, copied.tempDirectory]) assert.equal(existsNoFollow(file), false, 'Copied session artifacts were removed');
    assert.equal(conversations.findByGroup(group), null);
    assert.equal(sha(copied.mainSource), copied.manifest.mainSha256); assert.equal(sha(copied.childSource), copied.manifest.childSha256);
    assert.equal(fs.realpathSync(path.join(copied.sourceRoot, copied.manifest.taskLink)), copied.childSource, 'The prepared source link remains unchanged');
    assert.equal(errors.length, 0, errors[0]);
    await page.screenshot({ path: path.join(evidence, '1280-deleted.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(evidence, '390-deleted.png') });
    const proof = { provenance: copied.manifest.provenance, historicalCopy: true, freshModelRun: false,
      actualParentAgentCalls: copied.agentCalls, actualChildUsageResponses: copied.childReplies,
      copiedMainSha256: copied.manifest.mainSha256, copiedChildSha256: copied.manifest.childSha256,
      sourceCopyUnchanged: true, originalSourcesTouched: false, preview: cliResults[0].value, completed,
      removed: { main: !existsNoFollow(copied.main), child: !existsNoFollow(copied.child), leafLink: !existsNoFollow(copied.link), tempSessionDirectory: !existsNoFollow(copied.tempDirectory) },
      requests, isolation: f.sandbox.assertIsolation({ env: f.env }),
      controlBoundary: 'Private real Core CLI/activity-monitor; origin terminal is a fixture, target is an inactive genuine historical Claude session copy. No model/API/channel calls.' };
    fs.writeFileSync(path.join(evidence, 'deletion-proof.json'), JSON.stringify(proof, null, 2));
    console.log('Historical real subagent deletion:', JSON.stringify({ previewFiles: proof.preview.files, done: completed.pending === false,
      parentAgentCalls: proof.actualParentAgentCalls, childResponses: proof.actualChildUsageResponses, removed: proof.removed }));
  }, { timeoutMs: 90000 });
}
