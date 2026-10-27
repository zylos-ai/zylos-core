import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { stringify } from 'smol-toml';
import { installCoreCodexHook, codexHooksPath, codexTrustMarkerPath, ensureHooksFeature } from '../../cli/lib/codex-hooks.js';

const requireForFixture = createRequire(import.meta.url);

// Runtime/router fixtures exercise already-initialized instances. They retain
// real launch trust validation, while the dedicated trust regression exercises
// app-server repair. A fake CLI without repair support rejects app-server calls.
export function seedCodexTrustFixture({ root, home, codexHome = path.join(home, '.codex'), version = 'codex-fixture' }) {
  root = fs.realpathSync(root);
  installCoreCodexHook({ zylosDir: root });
  ensureHooksFeature({ projectDir: root, homeDir: home, codexHome });
  const hooksHash = createHash('sha256').update(fs.readFileSync(codexHooksPath(root))).digest('hex');
  const trustSnapshot = { [`${codexHooksPath(root)}:session_start:0:0`]: { enabled: true, trusted_hash: hooksHash } };
  fs.writeFileSync(path.join(codexHome, 'config.toml'), stringify({ features: { hooks: true }, hooks: { state: trustSnapshot } }));
  fs.writeFileSync(codexTrustMarkerPath(root), JSON.stringify({ hooksHash, codexVersion: version, trustSnapshot }));
}

// CJS source for fake model CLIs that also need trust repair (e.g. fixtures
// deliberately exercising spaces/quotes in the installation path). Only the
// external protocol is faked: installation, features and markers remain real.
export function codexAppServerFixtureSource() {
  return `
if (process.argv[2] === 'app-server') {
  const path = require('node:path');
  const crypto = require('node:crypto');
  const readline = require('node:readline');
  const { parse, stringify } = require(${JSON.stringify(requireForFixture.resolve('smol-toml'))});
  const reply = (id, result) => console.log(JSON.stringify({ id, result }));
  const deadline = setTimeout(() => process.exit(3), 5000);
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') reply(request.id, {});
    if (request.method === 'hooks/list') {
      const hooksPath = path.join(process.cwd(), '.codex', 'hooks.json');
      const currentHash = crypto.createHash('sha256').update(fs.readFileSync(hooksPath)).digest('hex');
      reply(request.id, { data: [{ hooks: [{ key: hooksPath + ':session_start:0:0', currentHash, isManaged: false }] }] });
    }
    if (request.method === 'config/batchWrite') {
      const configPath = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, '.codex'), 'config.toml');
      const config = parse(fs.readFileSync(configPath, 'utf8'));
      config.hooks ||= {}; config.hooks.state ||= {};
      Object.assign(config.hooks.state, request.params.edits[0].value);
      fs.writeFileSync(configPath, stringify(config));
      clearTimeout(deadline);
      reply(request.id, { status: 'ok' });
    }
  });
  return;
}
`;
}
