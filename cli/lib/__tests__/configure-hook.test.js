import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const {
  hasConfigureHook,
  resolveHookPath,
  runConfigureHook,
} = await import('../configure-hook.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-configure-hook-'));
}

describe('configure-hook', () => {
  it('detects non-empty configure hook declarations', () => {
    assert.equal(hasConfigureHook({ configure: 'hooks/configure.js' }), true);
    assert.equal(hasConfigureHook({ configure: '  ' }), false);
    assert.equal(hasConfigureHook({ 'post-install': 'hooks/post-install.js' }), false);
    assert.equal(hasConfigureHook(null), false);
  });

  it('resolves configure hook paths relative to the skill directory', () => {
    assert.equal(
      resolveHookPath('/tmp/component', 'hooks/configure.js'),
      path.resolve('/tmp/component/hooks/configure.js')
    );
    assert.equal(resolveHookPath('/tmp/component', ''), null);
  });

  it('pipes collected config as stdin JSON with component env vars', () => {
    const root = makeTempDir();
    const skillDir = path.join(root, 'skill');
    const dataDir = path.join(root, 'data');
    const hookDir = path.join(skillDir, 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const outputPath = path.join(dataDir, 'captured.json');
    fs.writeFileSync(path.join(hookDir, 'configure.js'), `
      import fs from 'node:fs';
      const input = await new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
      });
      fs.writeFileSync(process.env.ZYLOS_DATA_DIR + '/captured.json', JSON.stringify({
        component: process.env.ZYLOS_COMPONENT,
        skillDir: process.env.ZYLOS_SKILL_DIR,
        dataDir: process.env.ZYLOS_DATA_DIR,
        input: JSON.parse(input)
      }, null, 2));
    `);

    const result = runConfigureHook({
      componentName: 'example',
      skillDir,
      dataDir,
      hookRef: 'hooks/configure.js',
      configValues: { EXAMPLE_API_KEY: 'secret' },
      stdio: 'pipe',
    });

    assert.equal(result.success, true);
    const captured = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(captured.component, 'example');
    assert.equal(captured.skillDir, skillDir);
    assert.equal(captured.dataDir, dataDir);
    assert.deepEqual(captured.input, { EXAMPLE_API_KEY: 'secret' });
  });

  it('fails when configure hook is declared but missing', () => {
    const root = makeTempDir();
    const result = runConfigureHook({
      componentName: 'missing',
      skillDir: root,
      dataDir: root,
      hookRef: 'hooks/configure.js',
      configValues: {},
      stdio: 'pipe',
    });

    assert.equal(result.success, false);
    assert.match(result.error, /configure hook not found/);
  });
});
