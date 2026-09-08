#!/usr/bin/env node

/**
 * Zylos CLI - Main entry point
 * Usage: zylos <command> [options]
 */

import os from 'node:os';
import { parseUpstreamArgs, prepareUpstreams, withUpstreamSnapshot, setUpstreamSource, clearUpstreamSource, upstreamStatus } from './lib/upstreams.js';
import { commandExists } from './lib/shell-utils.js';
import path from 'node:path';
import { showStatus, showLogs, startServices, stopServices, restartServices } from './commands/service.js';

// Ensure ~/.local/bin is in PATH (Claude Code installs there)
const localBin = path.join(os.homedir(), '.local', 'bin');
if (!process.env.PATH.split(':').includes(localBin)) {
  process.env.PATH = `${localBin}:${process.env.PATH}`;
}
import { upgradeComponent, uninstallComponent, infoComponent, listComponents, searchComponents } from './commands/component.js';
import { addComponent } from './commands/add.js';
import { initCommand } from './commands/init.js';
import { configCommand } from './commands/config.js';
import { attachCommand } from './commands/attach.js';
import { doctorCommand } from './commands/doctor.js';
import { shellCommand } from './commands/shell.js';
import { runtimeCommand } from './commands/runtime.js';
import { migrateInstructionsCommand } from './commands/migrate-instructions.js';

const commands = {
  // Environment setup
  init: initCommand,
  upstream: upstreamCommand,
  config: configCommand,
  attach: attachCommand,
  doctor: doctorCommand,
  shell: shellCommand,
  runtime: runtimeCommand,
  'migrate-instructions': migrateInstructionsCommand,
  // Service management
  status: showStatus,
  logs: showLogs,
  start: startServices,
  stop: stopServices,
  restart: restartServices,
  // Component management
  add: addComponent,
  info: infoComponent,
  upgrade: upgradeComponent,
  uninstall: uninstallComponent,
  remove: uninstallComponent,
  list: listComponents,
  search: searchComponents,
  // Help
  help: showHelp,
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  // Handle --version / -v
  if (command === '--version' || command === '-v') {
    const { getCurrentVersion } = await import('./lib/self-upgrade.js');
    const result = getCurrentVersion();
    console.log(result.success ? result.version : 'unknown');
    return;
  }

  // Handle --help / -h
  if (command === '--help' || command === '-h') {
    showHelp();
    return;
  }

  if (commands[command]) {
    const parsed = parseUpstreamArgs(args.slice(1));
    const help = parsed.args.some(arg => ['--help', '-h'].includes(arg));
    const runtimeInstall = command === 'runtime' && ['claude', 'codex'].includes(parsed.args[0]) && !commandExists(parsed.args[0]);
    const consumesUpstream = ['init', 'add', 'upgrade', 'search'].includes(command) || runtimeInstall;
    if (consumesUpstream && !help) {
      const prepared = await prepareUpstreams({ source: parsed.source });
      await withUpstreamSnapshot(prepared, () => commands[command](parsed.args));
    } else if (command === 'doctor') {
      await commands[command](parsed.args, parsed.source);
    } else if (command === 'upstream') {
      await upstreamCommand(parsed.args, parsed.source);
    } else {
      if (parsed.source && !help) throw new Error('Upstream source flags require an upstream-consuming command');
      await commands[command](parsed.args);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }
}

async function upstreamCommand(args, source) {
  if (args.some(arg => ['--help', '-h'].includes(arg))) {
    console.log('Usage: zylos upstream [status [--resolved] | refresh | set <file|https-url|direct> | clear]\nTemporary override (status/refresh): --upstream-config <file|https-url|direct>');
    return;
  }
  const sub = args[0] || 'status';
  if (sub === 'set' || sub === 'clear') {
    if (source) throw new Error('upstream set/clear use explicit configuration arguments, not --upstream-config');
    if (sub === 'set') {
      if (args.length !== 2 || !args[1] || args[1].startsWith('-')) throw new Error('Usage: zylos upstream set <file|https-url|direct>');
      setUpstreamSource(args[1]);
      console.log('Default upstream source saved. CLI/environment overrides still take precedence.');
    } else {
      if (args.length !== 1) throw new Error('Usage: zylos upstream clear');
      clearUpstreamSource();
      console.log('Default upstream source cleared. Without CLI/environment overrides, official endpoints are used.');
    }
    return;
  }
  if (!['status', 'refresh'].includes(sub) || args.slice(1).some(arg => arg !== '--resolved')) throw new Error('Usage: zylos upstream [status [--resolved] | refresh | set <file|https-url|direct> | clear]');
  const prepared = await prepareUpstreams({ source, readOnly: sub === 'status', force: sub === 'refresh' });
  console.log(JSON.stringify(upstreamStatus(prepared, { resolved: args.includes('--resolved') }), null, 2));
}

function showHelp() {
  console.log(`
Zylos CLI

Usage: zylos <command> [options]

Setup:
  init                Initialize Zylos environment
                      --yes/-y  Non-interactive mode
                      --quiet/-q  Minimal output
                      Run "zylos init --help" for all options
  upstream status     Show profile/cache state without network (--resolved)
  upstream set <source>  Save a default source (file|https-url|direct)
  upstream clear      Clear the saved source; retain trust, cache and profile files
  upstream refresh    Refresh the selected remote profile
                      --upstream-config <file|https-url|direct> (this command only, including init)
  config              Show all configuration
  config get <key>    Get a config value
  config set <key> <value>  Set a config value
  attach              Attach to the Claude tmux session
  doctor              Diagnose and repair Zylos installation
                      --check   Diagnose only, no repairs
  shell               Interactive CLI mode (REPL)
  runtime <name>      Switch agent runtime (claude|codex)
  runtime status      Show currently configured runtime
  migrate-instructions  Analyze/migrate legacy mixed instructions (dry-run by default)
                      --apply  Create durable backup and activate split instructions
                      --user-content <file>  User-only content for conservative C-class migration

Service Management:
  status              Show system status
  logs [type]         Show logs (activity|scheduler|caddy|pm2)
  start               Start all services
  stop                Stop all services
  restart             Restart all services

Component Management:
  add <target>        Add a component
                      target: name[@ver] | org/repo[@ver] | url | local path
                      --branch <name>  Install from a git branch
                      --check   Show component info without installing
                      --yes/-y  Skip confirmation prompts
  info <name>         Show component details (--json)
  upgrade <name>      Upgrade a component (9-step pipeline)
  upgrade --all       Upgrade all components
  upgrade --self      Upgrade zylos-core itself
  uninstall <name>    Remove a component (--purge, --force)
  uninstall --self    Uninstall zylos entirely (--force to skip prompts)
  remove <name>       Alias for uninstall
  list                List installed components
  search [keyword]    Search available components

Other:
  help                Show this help

Examples:
  zylos shell
  zylos init
  zylos config set protocol http
  zylos status
  zylos logs activity

  zylos add telegram
  zylos add telegram@0.2.0
  zylos add lark --branch feature/new-thing
  zylos add user/my-component
  zylos upgrade telegram
  zylos upgrade --all
  zylos upgrade --self
  zylos info telegram
  zylos uninstall telegram --purge
  zylos uninstall --self
  zylos remove telegram --purge --yes
  zylos list
  zylos search bot
`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
