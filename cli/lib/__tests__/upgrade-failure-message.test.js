import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeFailureMessage } from '../upgrade-admission.js';

for (const warning of ['npm warn deprecated old-package', 'npm WARN deprecated old-package', 'deprecated old-package', 'npm notice update available']) {
  test(`failure reason skips ${warning}`, () => {
    assert.equal(upgradeFailureMessage(Error(`${warning}\nnpm error code 23\nnpm error path /private/package\nnpm error lifecycle install failed\n    at run (/private/file.js:1:2)`)),
      'npm error lifecycle install failed');
  });
}

test('failure reason keeps ordinary errors and sanitizes their paths', () => {
  assert.equal(upgradeFailureMessage(Error('Cannot read /private/package.\n    at run (file.js:1:2)')), 'Cannot read <path>');
  assert.equal(upgradeFailureMessage(Error('npm warn deprecated old-package\nfixture lifecycle install failed')), 'fixture lifecycle install failed');
  assert.equal(upgradeFailureMessage(Error('npm WARN old-package\nnpm ERR! Installation failed.')), 'npm ERR! Installation failed.');
});

for (const detail of ['npm warn deprecated old-package', 'npm error code 23\nnpm error command failed\nnpm error A complete log can be found in /private/log', '    at run (/private/file.js:1:2)', 'npm error stack Error: install failed\nnpm error     at run (/private/file.js:1:2)']) {
  test(`unusable failure detail gives concise log guidance (${detail.split('\n')[0]})`, () => {
    assert.equal(upgradeFailureMessage(Error(detail)), 'Core upgrade failed. Check the npm debug log in ~/.npm/_logs/ for details.');
  });
}

for (const warning of ['', 'npm warn deprecated old-package: no longer supported\n']) {
  test(`permission failure selects the explicit npm error (warning=${Boolean(warning)})`, () => {
    const stderr = `${warning}npm error code EACCES
npm error syscall rename
npm error path /fixture/bin/zylos
npm error dest /fixture/bin/.zylos-old
npm error errno -13
npm error Error: EACCES: permission denied, rename '/fixture/bin/zylos' -> '/fixture/bin/.zylos-old'`;
    assert.equal(upgradeFailureMessage(Error(stderr)), "EACCES: permission denied, rename '<path>' -> '<path>'");
  });
}

test('unknown npm metadata keys do not become the failure reason', () => {
  assert.equal(upgradeFailureMessage(Error('npm error dest /fixture/bin\nnpm error cwd /fixture\nnpm error signal SIGTERM\nnpm error location /fixture/package\nnpm error workspace example')),
    'Core upgrade failed. Check the npm debug log in ~/.npm/_logs/ for details.');
});
