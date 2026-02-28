#!/usr/bin/env node

/**
 * Zylos CLI - Main entry point
 * Usage: zylos <command> [options]
 */

import os from 'node:os';
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

const commands = {
  // Environment setup
  init: initCommand,
  config: configCommand,
  attach: attachCommand,
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
    await commands[command](args.slice(1));
  } else {
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }
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
  config              Show all configuration
  config get <key>    Get a config value
  config set <key> <value>  Set a config value
  attach              Attach to the Claude tmux session

Service Management:
  status              Show system status
  logs [type]         Show logs (activity|scheduler|caddy|pm2)
  start               Start all services
  stop                Stop all services
  restart             Restart all services

Component Management:
  add <target>        Add a component
                      target: name[@ver] | org/repo[@ver] | url
                      --branch <name>  Install from a git branch
                      --check   Show component info without installing
                      --yes/-y  Skip confirmation prompts
  info <name>         Show component details (--json)
  upgrade <name>      Upgrade a component (8-step pipeline)
  upgrade --all       Upgrade all components
  upgrade --self      Upgrade zylos-core itself
  uninstall <name>    Remove a component (--purge, --force)
  remove <name>       Alias for uninstall
  list                List installed components
  search [keyword]    Search available components

Other:
  help                Show this help

Examples:
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
  zylos remove telegram --purge --yes
  zylos list
  zylos search bot
`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
