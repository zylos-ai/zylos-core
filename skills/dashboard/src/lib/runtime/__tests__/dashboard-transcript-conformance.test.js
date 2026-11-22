import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../config.js';
import { loadCoreModule } from '../../core-modules.js';
import { Store } from '../../store.js';
import { UNSUPPORTED } from '../contract.js';
import { getDashboardRuntime } from '../index.js';

const { getRuntime, runtimesWith } = await loadCoreModule('runtime/index.js');

for (const id of runtimesWith('usage')) {
  test(`${id} records priced usage and lists the main session from a native transcript`, async t => {
    const samples = new URL(`./samples/${id}/usage/`, import.meta.url);
    const manifestFile = new URL('manifest.json', samples);
    assert.ok(fs.existsSync(manifestFile), `Missing native transcript manifest for ${id}`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const files = Object.keys(manifest.files).filter(file => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const [file] = files;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-native-transcript-'));
    const store = new Store(path.join(root, 'dashboard.db'));
    t.after(() => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const { transcript } = (await getRuntime(id)).usage;
    const { collector, history: History, pricing } = await getDashboardRuntime(id);
    const zylosDir = fs.realpathSync(root);
    const homeDir = zylosDir;
    const scope = { home: homeDir, zylosDir };
    const directory = transcript.projectDir === UNSUPPORTED ? transcript.root(scope) : transcript.projectDir(scope);
    fs.mkdirSync(directory, { recursive: true });
    const sessionId = 'native-transcript';
    const transcriptPath = path.join(directory, transcript.isTranscriptFile === UNSUPPORTED ? `${sessionId}.jsonl` : `rollout-${sessionId}.jsonl`);
    fs.copyFileSync(new URL(file, samples), transcriptPath);

    const config = { ...loadConfig({ zylosDir, pricing: { [id]: pricing } }), homeDir };
    store.insertEvent({
      id: 'native-session-start', ingest_id: 'native-session-start', timestamp: new Date().toISOString(),
      runtime: id, session_id: sessionId, session_group: 'origin',
      event_type: 'session_start', category: 'session', metadata: { transcript_path: transcriptPath }, source: 'core-log',
    });
    const instance = collector.create(store, config);
    await instance.collect();

    const usage = store.queryMetrics({ name: 'usage_event' });
    assert.ok(usage.length > 0);
    for (const row of usage) assert.equal(row.runtime, id);
    assert.ok(usage.some(({ dimensions }) => typeof dimensions.model === 'string' &&
      instance._resolveModelPrice(dimensions.model, dimensions.service_tier) && dimensions.cost > 0));

    const { sessions } = await new History({ homeDir, zylosDir, store }).listSessions();
    assert.deepEqual(sessions.map(({ id, kind }) => ({ id, kind })), [{ id: sessionId, kind: 'main' }]);
  });
}
