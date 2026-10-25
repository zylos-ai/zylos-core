import { runConfigCli } from '../../skills/comm-bridge/scripts/c4-config-handler.js';

export async function groupCommand(args, { run = runConfigCli, io = process } = {}) {
  const [kind, ...flags] = args;
  if (!['runtime', 'model'].includes(kind)) {
    const result = { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Usage: zylos group <runtime|model> <get|set|reset> [options]', persisted: [] } };
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else console.error(`Error [${result.error.code}]: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
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
