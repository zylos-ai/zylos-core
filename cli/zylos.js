#!/usr/bin/env node

/**
 * Zylos CLI - Main entry point
 * Usage: zylos <command> [options]
 */

const { showStatus, showLogs, startServices, stopServices, restartServices } = require('./commands/service');
const { installComponent, upgradeComponent, uninstallComponent, listComponents, searchComponents } = require('./commands/component');

const commands = {
  // Service management
  status: showStatus,
  logs: showLogs,
  start: startServices,
  stop: stopServices,
  restart: restartServices,
  // Component management
  install: installComponent,
  upgrade: upgradeComponent,
  uninstall: uninstallComponent,
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

Service Management:
  status              Show system status
  logs [type]         Show logs (activity|scheduler|caddy|pm2)
  start               Start all services
  stop                Stop all services
  restart             Restart all services

Component Management:
  install <target>    Install a component
                      target: name[@ver] | org/repo[@ver] | url
  upgrade <name>      Upgrade a specific component
  upgrade --all       Upgrade all components
  upgrade --self      Upgrade zylos-core itself
  uninstall <name>    Uninstall a component (--purge for data)
  list                List installed components
  search [keyword]    Search available components

Other:
  help                Show this help

Examples:
  zylos status
  zylos logs activity

  zylos install telegram
  zylos install telegram@0.2.0
  zylos install kevin/whatsapp
  zylos upgrade telegram
  zylos upgrade --all
  zylos upgrade --self
  zylos uninstall telegram --purge
  zylos list
  zylos search bot
`);
}

main().catch(console.error);
