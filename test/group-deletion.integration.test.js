import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGroupDeletionFixture } from './helpers/group-deletion-fixture.js';

// Exercises a killed deletion CLI and delivery of retained input into a new
// run. Run for deletion, reclaim or dispatcher changes. The fixture verifies
// private HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR, tmux and C4 DB before launch,
// and reaps its runtime and subprocesses even on failure or timeout.
test('deletion survives a killed CLI and delivers fenced input into a recreated run',
  { timeout: 70_000 }, async t => {
    const f = await createGroupDeletionFixture(t);
    await f.sandbox.runCase(async () => {
      const group = 'telegram:room', operationId = randomUUID();
      const old = f.store.insertConversation('in', 'telegram', 'room', 'old input', { groupName: 'room' });
      f.store.claimConversation(old.id); f.store.markDelivered(old.id, { sessionId: 'old-session' });
      f.store.insertConversation('out', 'telegram', 'room', 'old reply', { groupName: 'room' });
      const other = f.store.insertConversation('in', 'telegram', 'other', 'unrelated', { groupName: 'other' });
      f.store.claimConversation(other.id); f.store.markDelivered(other.id, { sessionId: 'other-session' });
      const identity = f.startRuntime(group, { runId: 'old-run', sessionId: 'old-session' });
      const oldScene = await f.waitFor(async () => {
        const scene = await f.scenes.observeGroup(group);
        return scene.processRunning === true ? scene : null;
      }, 'Old process must be observed');
      const dir = path.join(f.root, 'memory/session-groups', group);
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'state.md'), 'private old content');
      f.setBusy(true);
      const child = f.startDeleteChild({ group, operationId, pauseAfterFiles: true });
      await f.waitFor(() => f.store.getDrainFence(group)?.reason === 'delete', 'Native admission must persist the delete fence');
      const queued = f.store.insertConversation('in', 'telegram', 'room', 'FENCED_INPUT_RECEIPT', { groupName: 'room' });
      assert.equal(f.store.claimConversation(queued.id), false);
      const busyRound = JSON.parse(fs.readFileSync(path.join(f.root, 'monitor-round.json'))).rounds;
      await f.waitFor(() => JSON.parse(fs.readFileSync(path.join(f.root, 'monitor-round.json'))).rounds >= busyRound + 2,
        'Monitor must observe the busy fenced runtime across rounds');
      assert.equal(f.runtimePresent(group), true, 'Busy runtime remains running while draining');
      f.setBusy(false);
      await f.waitFor(() => fs.existsSync(path.join(f.root, 'files-removed')), 'CLI must reach the pre-commit file-removal barrier');
      assert.equal(f.runtimePresent(group), false, 'Actual old tmux runtime exited before file removal');
      await f.waitFor(() => {
        try { process.kill(oldScene.runtimePid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
      }, 'Old runtime process PID must be gone');
      assert.equal(f.store.listRunEndings([group]).some(row => row.reason === 'delete' && row.runId === identity.runId), true);
      assert.equal(fs.readFileSync(path.join(dir, 'state.md'), 'utf8'), 'private old content', 'Queued input keeps ambiguous group memory');
      process.kill(child.pid, 'SIGKILL');
      const killed = await child.completion;
      assert.equal(killed.signal, 'SIGKILL');
      assert.equal(f.store.getGroupDeletionAudit(operationId).status, 'started');
      assert.equal(f.database.prepare('SELECT operation_id FROM drain_fences WHERE session_group=?').get(group).operation_id, operationId);
      assert.equal(f.database.prepare('SELECT status FROM conversations WHERE id=?').get(queued.id).status, 'pending');
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM conversations WHERE id=?').get(old.id).n, 1, 'Killed transaction rolls back SQL');
      const retry = f.startDeleteChild({ group, operationId });
      const result = await retry.completion;
      assert.equal(result.code, 0, result.stderr + result.stdout);
      const receipt = JSON.parse(result.stdout.trim());
      assert.equal(receipt.pending, false);
      assert.equal(receipt.countsEstimated, true);
      assert.equal(receipt.retainedMessages, 1); assert.equal(receipt.groupDataRetained, true);
      assert.equal(f.store.getGroupDeletionAudit(operationId).status, 'done');
      assert.equal(f.store.getDrainFence(group), null);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM group_deletion_audit WHERE operation_id=?').get(operationId).n, 1);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM conversations WHERE id=?').get(old.id).n, 0);
      assert.equal(f.database.prepare('SELECT content FROM conversations WHERE id=?').get(other.id).content, 'unrelated');
      assert.equal(f.database.prepare('SELECT status FROM conversations WHERE id=?').get(queued.id).status, 'pending');
      assert.equal(f.runtimePresent(group), false, 'Deletion never automatically restarts the runtime');
      f.startDispatcher();
      await f.waitFor(() => f.database.prepare('SELECT status FROM conversations WHERE id=?').get(queued.id).status === 'delivered', 'Production router/delivery must settle retained input', 20_000);
      const replacement = await f.scenes.observeGroup(group);
      assert.equal(replacement.ready, true); assert.equal(replacement.processRunning, true);
      assert.notEqual(replacement.runId, identity.runId);
      await f.waitFor(() => fs.existsSync(path.join(f.root, 'runtime-input.txt')) &&
        fs.readFileSync(path.join(f.root, 'runtime-input.txt'), 'utf8').includes('FENCED_INPUT_RECEIPT'), 'Real terminal must consume preserved input');
      console.log('Deletion integration proof:', JSON.stringify({ operationId, killed: killed.signal,
        oldRun: identity.runId, replacementRun: replacement.runId, queuedId: queued.id, actualTerminalReceipt: true }));
    }, { timeoutMs: 60_000 });
  });
