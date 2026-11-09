import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Coverage: model-facing realtime/startup/CLI/absorbed/conversion/component
// readers. Run for projection or consumer changes; skip only without the main
// integration opt-in. Explicit component source directories are test fixtures,
// never the agent's installed components or live data directories.
export async function runConsumerCase(t, sandbox) {
  for (const key of ['ZYLOS_CHAT_IDENTITY_SOURCE', 'ZYLOS_CHAT_THINKING_SOURCE']) {
    assert.ok(process.env[key], `${key} must point to the reviewed component source checkout`);
    const source = fs.realpathSync(process.env[key]);
    assert.ok(fs.statSync(path.join(source, 'package.json')).isFile());
  }
  sandbox.assertIsolation();
  const { default: Database } = await import('../../../comm-bridge/scripts/sqlite-driver.js');
  const database = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  database.close();
  const env = { ...sandbox.env, PATH: path.dirname(process.execPath) + path.delimiter + sandbox.env.PATH,
    ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../../', import.meta.url)),
    ZYLOS_CHAT_CONSUMER_ROOT: sandbox.root,
    ZYLOS_CHAT_IDENTITY_SOURCE: fs.realpathSync(process.env.ZYLOS_CHAT_IDENTITY_SOURCE),
    ZYLOS_CHAT_THINKING_SOURCE: fs.realpathSync(process.env.ZYLOS_CHAT_THINKING_SOURCE),
    ZYLOS_CHAT_TMUX_SOCKET: sandbox.paths.socket,
  };
  const child = sandbox.startChild(process.execPath,
    [fileURLToPath(new URL('./chat-consumer-child.js', import.meta.url))], { env, maxOutputBytes: 262144 });
  const result = await child.completion;
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.outputExceeded, false);
  const report = JSON.parse(result.stdout.trim());
  assert.ok(Number.isSafeInteger(report.assertions) && report.assertions > 0);
  assert.equal(report.firstCounterexample, null);
  t.diagnostic(JSON.stringify(report));
  return report;
}
