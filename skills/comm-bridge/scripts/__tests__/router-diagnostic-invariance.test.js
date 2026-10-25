import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { routerFixture } from './helpers/router-fixture.js';
import { createRouterDiagnostics } from '../router/diagnostics.js';
import { createJsonlStream } from '../../../../cli/lib/jsonl-stream.js';

// IF-31 / IF10-11a caller side: diagnostic history is not authority.
test('false, truncated, removed and rotated diagnostics leave router decisions unchanged', async t => {
  const results = [];
  for (const variant of ['empty', 'false', 'truncated', 'removed', 'rotated', 'write-failed']) {
    await t.test(variant, async t => {
      const f = routerFixture(t);
      f.put('origin');
      const message = f.add('a');
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'router-invariance-'));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const file = path.join(directory, 'router-events.jsonl');
      const receive = path.join(directory, 'receive-events.jsonl');
      const supervisor = path.join(directory, 'supervisor-events.jsonl');
      const forged = [
        { v: 1, event: 'activate_new', session_group: 'a', runId: 'nonexistent' },
        { v: 1, event: 'wait_health', session_group: 'a', code: 'auth_blocked' },
      ].map(row => JSON.stringify(row)).join('\n') + '\n';
      for (const filename of [file, receive, supervisor]) {
        await fs.writeFile(filename, variant === 'empty' ? '' : forged);
        if (variant === 'truncated') await fs.writeFile(filename, '{"event":');
        if (variant === 'removed') await fs.unlink(filename);
        if (variant === 'rotated') await fs.rename(filename, `${filename}.old`);
      }
      const failures = [];
      const stream = createJsonlStream(file, variant === 'write-failed' ? {
        write: () => { throw new Error('injected write failure'); },
      } : {});
      const diagnostics = createRouterDiagnostics({ stream, receiveStream: createJsonlStream(receive),
        now: f.now, stderr: message => failures.push(message) });
      f.deps.diagnostic = diagnostics.diagnostic;
      f.deps.maintainDiagnostics = diagnostics.maintain;
      f.deps.flushDiagnostics = diagnostics.flush;
      const reads = f.deps.readRuntimeHealth;
      f.deps.readRuntimeHealth = runtime => { f.calls.push(['health', runtime]); return reads(runtime); };
      await f.create().initialize();
      await f.rounds(3);
      await f.router.stop();
      assert.equal(f.row(message.id).status, 'delivered');
      assert.equal(f.row(message.id).retry_count, 0);
      const timeline = f.calls.filter(([kind]) => ['launch','stop','submit','conversation','control','health'].includes(kind))
        .map(([kind, value]) => kind === 'launch' ? [kind, value.sessionGroup, value.launchConfig] : [kind, value]);
      results.push(timeline);
      if (variant === 'write-failed') assert(failures.length > 0);
    });
  }
  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
});
