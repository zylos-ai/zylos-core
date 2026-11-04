export async function groupCommand(args, { run, io = process } = {}) {
  const [kind, ...flags] = args;
  if (kind === 'overrides') {
    const json = flags.includes('--json');
    if (flags.some(flag => flag !== '--json') || flags.length > 1) {
      const result = { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Usage: zylos group overrides [--json]', persisted: [] } };
      (json ? io.stdout : io.stderr).write(json ? `${JSON.stringify(result)}\n` : `Error [${result.error.code}]: ${result.error.message}\n`);
      process.exitCode = 1;
      return 1;
    }
    try {
      const { listOverrides } = await import('../../skills/comm-bridge/scripts/c4-config-handler.js');
      const store = await import('../../skills/comm-bridge/scripts/c4-db.js');
      const data = listOverrides({ store });
      io.stdout.write(json ? `${JSON.stringify({ ok: true, data })}\n` : `OK: ${JSON.stringify(data)}\n`);
      process.exitCode = 0;
      return 0;
    } catch (error) {
      const result = { ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } };
      (json ? io.stdout : io.stderr).write(json ? `${JSON.stringify(result)}\n` : `Error [${result.error.code}]: ${error.message}\n`);
      process.exitCode = 1;
      return 1;
    }
  }
  if (!['runtime', 'model'].includes(kind)) {
    const result = { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Usage: zylos group <runtime|model> <get|set|reset> [options] | zylos group overrides [--json]', persisted: [] } };
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else console.error(`Error [${result.error.code}]: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (run === undefined) run = (await import('../../skills/comm-bridge/scripts/c4-config-handler.js')).runConfigCli;
  let exitCode;
  if (flags.includes('--json')) exitCode = await run(kind, flags, io);
  else {
    let output = '';
    exitCode = await run(kind, [...flags, '--json'], { stderr: io.stderr, stdout: { write: text => { output += text; } } });
    const result = JSON.parse(output);
    if (!result.ok) io.stderr.write(`Error [${result.error.code}]: ${result.error.message}\n`);
    else {
      const data = result.data;
      io.stdout.write(`OK: ${JSON.stringify(data)}\n`);
      if (data.running === null) {
        if (data.sessionMode !== 'multi') io.stdout.write('Applies only in multi session mode.\n');
        else if (kind === 'model' && data.runtime !== data.resolved?.runtime) io.stdout.write(`Saved configuration for ${data.runtime}; current group runtime is ${data.resolved?.runtime ?? 'unknown'}.\n`);
      }
    }
  }
  process.exitCode = exitCode;
  return exitCode;
}
