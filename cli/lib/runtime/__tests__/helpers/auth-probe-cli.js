const scenario = JSON.parse(process.env.TEST_AUTH_PROBE_SCENARIO);
if (process.argv.slice(2).join(' ') !== scenario.args) process.exit(98);
if (scenario.stdout) await new Promise(resolve => process.stdout.write(scenario.stdout, resolve));
if (scenario.stderr) await new Promise(resolve => process.stderr.write(scenario.stderr, resolve));
if (scenario.signal) process.kill(process.pid, scenario.signal);
else if (scenario.wait) setTimeout(() => process.exit(99), 60000);
else process.exit(scenario.exitCode);
