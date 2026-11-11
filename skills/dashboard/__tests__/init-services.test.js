import test from 'node:test';
import assert from 'node:assert/strict';
import { startServicesWithDashboard } from '../../../cli/commands/init.js';

// Shared init wiring unit boundary: the real exported helper with only service
// startup, cleanup and process-list saving injected. Run for init wiring changes.
// Official runner isolates HOME/ZYLOS_DIR/PM2/temp/socket targets before import;
// this case reads isolated Dashboard configuration, with no database, service,
// terminal or child process.
test('shared init startup passes quiet and Dashboard options to service startup', async () => {
  for (const quiet of [false, true]) {
    let observed;
    let saves = 0;
    const result = await startServicesWithDashboard({ quiet, caddy: false },
      async access => { observed = access; return 2; }, {
        finalizeWebConsoleRemoval:()=>({warnings:[],pm2Changed:false}),
        savePm2ProcessList:()=>{saves++;},
      });
    assert.equal(observed.quiet, quiet);
    assert.equal(observed.noCaddy, true);
    assert.equal(observed.zylosDir, process.env.ZYLOS_DIR);
    assert.equal(result.dashboardAccess, observed);
    assert.equal(result.servicesStarted, 2);
    assert.equal(saves, 0);
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
  let saves = 0;
  const operation = startServicesWithDashboard({ quiet: true }, async access => {
    await pending;
    access.password = 'fixture-generated-password';
    return 3;
  }, {finalizeWebConsoleRemoval:()=>({warnings:[],pm2Changed:false}),
    savePm2ProcessList:()=>{saves++;}});
  operation.then(() => { returned = true; });
  try {
    await Promise.resolve();
    assert.equal(returned, false, 'init cannot finish while service startup is pending');
  } finally { release(); }
  const result = await operation;
  assert.equal(result.servicesStarted, 3);
  assert.equal(result.dashboardAccess.password, 'fixture-generated-password');
  assert.equal(saves, 0);
});

test('shared init saves once when cleanup deletes a PM2 record', async () => {
  let saves = 0;
  await startServicesWithDashboard({caddy:false}, async()=>0, {
    finalizeWebConsoleRemoval:()=>({warnings:[],pm2Changed:true}),
    savePm2ProcessList:()=>{saves++;},
  });
  assert.equal(saves, 1);
});
