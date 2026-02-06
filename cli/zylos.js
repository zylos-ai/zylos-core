#!/usr/bin/env node

/**
 * Zylos CLI - Main entry point
 * Usage: zylos <command> [options]
 */

import { showStatus, showLogs, startServices, stopServices, restartServices } from './commands/service.js';
import { upgradeComponent, uninstallComponent, infoComponent, listComponents, searchComponents } from './commands/component.js';
import { addComponent } from './commands/add.js';
import { initCommand } from './commands/init.js';

const commands = {
  // Environment setup
  init: initCommand,
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
                      --yes/-y  Skip confirmation prompts

Service Management:
  status              Show system status
  logs [type]         Show logs (activity|caddy|pm2)
  start               Start all services
  stop                Stop all services
  restart             Restart all services

Component Management:
  add <target>        Add a component
                      target: name[@ver] | org/repo[@ver] | url
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
  zylos status
  zylos logs activity

  zylos add telegram
  zylos add telegram@0.2.0
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

main().catch(console.error);
