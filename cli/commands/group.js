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
  const output = flags.includes('--json') ? io : {
    stderr: io.stderr,
    stdout: { write(text) {
      io.stdout.write(text);
      if (!text.startsWith('OK: ')) return;
      try {
        const data = JSON.parse(text.slice(4));
        if (data.running !== null) return;
        if (data.sessionMode !== 'multi') io.stdout.write('Applies only in multi session mode.\n');
        else if (kind === 'model' && data.runtime !== data.resolved?.runtime) io.stdout.write(`Saved configuration for ${data.runtime}; current group runtime is ${data.resolved?.runtime ?? 'unknown'}.\n`);
      } catch { /* The formal wrapper owns output and errors. */ }
    } },
  };
  const exitCode = await run(kind, flags, output);
  process.exitCode = exitCode;
  return exitCode;
}
