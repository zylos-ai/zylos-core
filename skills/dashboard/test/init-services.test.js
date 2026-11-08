import test from 'node:test';
import assert from 'node:assert/strict';
import { startServicesWithDashboard } from '../../../cli/commands/init.js';

// Shared init wiring unit boundary: the real exported helper with only service
// startup injected. Run for init quiet/options wiring; unrelated UI may skip.
// Official runner isolates HOME/ZYLOS_DIR/PM2/temp/socket targets before import;
// this case opens no files, database, service, terminal or child process.
test('shared init startup passes quiet and Dashboard options to service startup', async () => {
  for (const quiet of [false, true]) {
    let observed;
    const result = await startServicesWithDashboard({ quiet, caddy: false, webPassword: 'fixture-web-password' },
      async (webPassword, access) => { observed = { webPassword, access }; return 2; });
    assert.equal(observed.webPassword, 'fixture-web-password');
    assert.equal(observed.access.quiet, quiet);
    assert.equal(observed.access.noCaddy, true);
    assert.equal(observed.access.zylosDir, process.env.ZYLOS_DIR);
    assert.equal(result.dashboardAccess, observed.access);
    assert.equal(result.servicesStarted, 2);
  }
});

// Async completion boundary: the real shared helper must remain pending until
// startup has finished populating its access object. Run for startup await /
// return changes; unrelated UI may skip. Same official isolated import setup;
// a test-owned promise is released in finally, with no background I/O/resources.
test('shared init startup awaits services before returning the password and count', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let returned = false;
  const operation = startServicesWithDashboard({ quiet: true }, async (_webPassword, access) => {
    await pending;
    access.password = 'fixture-generated-password';
    return 3;
  });
  operation.then(() => { returned = true; });
  try {
    await Promise.resolve();
    assert.equal(returned, false, 'init cannot finish while service startup is pending');
  } finally { release(); }
  const result = await operation;
  assert.equal(result.servicesStarted, 3);
  assert.equal(result.dashboardAccess.password, 'fixture-generated-password');
});
