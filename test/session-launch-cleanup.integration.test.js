import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupLaunch, binary } from '../cli/lib/runtime/__tests__/launch-tmux-fixture.js';
import { injectLaunchCleanupRace } from '../cli/lib/runtime/__tests__/helpers/launch-cleanup-race.js';
import { writeSessionLaunchScript, shellQuote } from '../cli/lib/runtime/session-command.js';
import { settleLaunch } from '../cli/lib/runtime/session-launch.js';

// Boundary: real tmux settlement plus real launch-script cleanup. Run when
// launch cleanup or its settlement caller changes; skip for unrelated changes.
// The runner isolates HOME, ZYLOS_DIR, PM2_HOME and TMPDIR before import; the
// fixture owns a private socket and tears down its server on failure/timeout.
// No database is used. Nothing targets the live instance.
for (const outcome of ['success', 'client failure', 'name conflict']) {
  for (const operation of ['readdirSync', 'unlinkSync', 'rmdirSync']) {
    test(`launch ${outcome} survives cleanup race during ${operation}`, {timeout:10000}, async t => {
      const f = await setupLaunch(t);
      assert.ok(f.dir.startsWith(process.env.TMPDIR + path.sep));
      assert.ok(f.socketPath.startsWith(f.dir + path.sep));
      for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME']) {
        assert.ok(process.env[key].startsWith(path.dirname(process.env.TMPDIR) + path.sep));
      }
      t.diagnostic(JSON.stringify({HOME:process.env.HOME, ZYLOS_DIR:process.env.ZYLOS_DIR,
        PM2_HOME:process.env.PM2_HOME, TMPDIR:process.env.TMPDIR, socketPath:f.socketPath}));
      const script = writeSessionLaunchScript({command:'/bin/sleep', args:['30'], env:{PATH:process.env.PATH}, root:f.dir, multi:false});
      const cleanup = script.cleanup;
      t.after(() => { t.mock.restoreAll(); cleanup(); });
      let verified = false;
      script.cleanup = () => {
        // Reconstruct the two-entry tree at settlement so the race occurs at a
        // deterministic deletion step even if launch.sh has already finished.
        fs.mkdirSync(path.dirname(script.file), {recursive:true});
        fs.writeFileSync(script.file, 'fixture');
        const verify = injectLaunchCleanupRace(t, script, operation);
        try { cleanup(); } finally { verify(); }
        verified = true;
      };
      let tmuxBinary = binary;
      if (outcome === 'client failure') {
        tmuxBinary = path.join(f.dir, 'receipt-error');
        fs.writeFileSync(tmuxBinary, `#!/bin/sh\ncase " $* " in\n*" new-session "*) ${shellQuote(binary)} "$@"; echo 'fixture failure after receipt' >&2; exit 7 ;;\n*) exec ${shellQuote(binary)} "$@" ;;\nesac\n`, {mode:0o700});
      }
      const launch = settleLaunch({tmuxName:outcome === 'name conflict' ? 'keeper' : 'target',
        runId:'cleanup-run', launchConfig:{runtime:'claude', mode:'default'}, sessionGroup:null,
        root:f.dir, script, tmux:{binary:tmuxBinary, socketPath:f.socketPath, configFile:'/dev/null'}});
      if (outcome === 'success') {
        const result = await launch;
        assert.equal(result.tmuxName, 'target');
        assert.ok(Number.isSafeInteger(result.createdAt));
      } else {
        await assert.rejects(launch, {code:outcome === 'name conflict' ? 'NAME_CONFLICT' : 'LAUNCH_FAILED'});
        assert.equal(f.tmux('list-sessions', '-F', '#{session_name}').trim(), 'keeper');
      }
      assert.equal(verified, true);
    });
  }
}
