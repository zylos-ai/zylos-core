#!/usr/bin/env node
/**
 * C6 HTTP Layer - Caddy Setup Script
 * Sets up Caddy web server for file sharing and optional proxies
 *
 * Usage: node setup-caddy.js [--with-lark] [--with-browser]
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

// ANSI colors
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const NC = '\x1b[0m';

// Parse arguments
const args = process.argv.slice(2);
let withLark = false;
let withBrowser = false;

for (const arg of args) {
  if (arg === '--with-lark') {
    withLark = true;
  } else if (arg === '--with-browser') {
    withBrowser = true;
  } else if (arg !== '--help' && arg !== '-h') {
    console.error(`Unknown option: ${arg}`);
    console.error('Usage: node setup-caddy.js [--with-lark] [--with-browser]');
    process.exit(1);
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node setup-caddy.js [--with-lark] [--with-browser]');
  console.log('');
  console.log('Options:');
  console.log('  --with-lark     Add Lark webhook proxy');
  console.log('  --with-browser  Add VNC/browser proxy');
  process.exit(0);
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function readEnvFile(filePath) {
  const env = {};
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        let value = match[2].trim();
        // Remove quotes
        value = value.replace(/^["']|["']$/g, '');
        env[match[1].trim()] = value;
      }
    }
  }
  return env;
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`${BLUE}C6 HTTP Layer - Caddy Setup${NC}`);
  console.log('============================');
  console.log('');

  // Check for .env file
  const envFile = path.join(ZYLOS_DIR, '.env');
  if (!fs.existsSync(envFile)) {
    console.error(`${RED}Error: ${envFile} not found${NC}`);
    console.error('Create .env file with DOMAIN=your.domain.com');
    process.exit(1);
  }

  // Read domain from .env
  const env = readEnvFile(envFile);
  let domain = env.DOMAIN || '';

  if (!domain) {
    console.log(`${YELLOW}No domain configured in .env${NC}`);
    domain = await prompt('Enter your domain (e.g., zylos.example.com): ');
    if (domain) {
      fs.appendFileSync(envFile, `DOMAIN=${domain}\n`);
    } else {
      console.error(`${RED}Domain is required. Exiting.${NC}`);
      process.exit(1);
    }
  }

  console.log(`Domain: ${domain}`);
  console.log(`Zylos directory: ${ZYLOS_DIR}`);
  console.log('');

  // Create required directories
  fs.mkdirSync(path.join(ZYLOS_DIR, 'public'), { recursive: true });
  fs.mkdirSync(path.join(ZYLOS_DIR, 'http'), { recursive: true });

  // Fix permissions for Caddy to read public files
  try {
    execSync(`chmod o+rx "${os.homedir()}" 2>/dev/null || true`, { stdio: 'pipe' });
    execSync(`chmod o+rx "${ZYLOS_DIR}" 2>/dev/null || true`, { stdio: 'pipe' });
    execSync(`chmod -R o+r "${ZYLOS_DIR}/public" 2>/dev/null || true`, { stdio: 'pipe' });
  } catch {}

  // Generate Caddyfile
  const caddyfile = path.join(ZYLOS_DIR, 'Caddyfile');
  console.log('Generating Caddyfile...');

  const timestamp = new Date().toISOString();
  let config = `# Zylos C6 HTTP Layer - Generated Caddyfile
# Domain: ${domain}
# Generated: ${timestamp}

${domain} {
    root * ${ZYLOS_DIR}/public

    file_server {
        hide .git .env *.db *.json
    }

    @markdown path *.md
    handle @markdown {
        header Content-Type "text/plain; charset=utf-8"
    }

    handle /health {
        respond "OK" 200
    }
`;

  // Add Lark proxy if requested
  if (withLark) {
    console.log(`  ${GREEN}+${NC} Adding Lark webhook proxy`);
    config += `
    # Lark webhook proxy
    handle /lark/* {
        uri strip_prefix /lark
        reverse_proxy localhost:3457
    }
`;
  }

  // Add browser/VNC proxy if requested
  if (withBrowser) {
    console.log(`  ${GREEN}+${NC} Adding VNC/browser proxy`);
    config += `
    # noVNC remote desktop
    handle /vnc/* {
        uri strip_prefix /vnc
        reverse_proxy localhost:6080
    }

    # Browser agent WebSocket
    handle /ws {
        reverse_proxy localhost:8765
    }
`;
  }

  // Add logging and close
  config += `
    log {
        output file ${ZYLOS_DIR}/http/caddy-access.log {
            roll_size 10mb
            roll_keep 3
        }
    }
}
`;

  fs.writeFileSync(caddyfile, config);

  console.log('');
  console.log('Generated Caddyfile:');
  console.log('---');
  console.log(config);
  console.log('---');
  console.log('');

  // Check if Caddy is installed
  if (!commandExists('caddy')) {
    console.log(`${YELLOW}Caddy is not installed.${NC}`);
    console.log('Install with: sudo apt install -y caddy');
    console.log('Or see: https://caddyserver.com/docs/install');
    console.log('');
    console.log(`Caddyfile saved to: ${caddyfile}`);
    process.exit(0);
  }

  // Ask to apply configuration
  const apply = await prompt('Apply Caddy configuration now? (Y/n): ');

  if (apply.toLowerCase() !== 'n') {
    try {
      execSync(`sudo cp "${caddyfile}" /etc/caddy/Caddyfile`, { stdio: 'inherit' });
      try {
        execSync('sudo systemctl enable caddy 2>/dev/null || true', { stdio: 'pipe' });
      } catch {}
      execSync('sudo systemctl restart caddy', { stdio: 'inherit' });

      console.log('');
      console.log(`${GREEN}Caddy configured and started!${NC}`);
      console.log('');
      console.log(`Your site is live at: https://${domain}/`);
      console.log('');
      console.log('Verify with:');
      console.log('  sudo systemctl status caddy');
      console.log(`  curl -I https://${domain}/health`);
    } catch (err) {
      console.error(`${RED}Failed to apply configuration: ${err.message}${NC}`);
      process.exit(1);
    }
  } else {
    console.log('');
    console.log(`Caddyfile saved to: ${caddyfile}`);
    console.log('Apply manually:');
    console.log(`  sudo cp ${caddyfile} /etc/caddy/Caddyfile`);
    console.log('  sudo systemctl restart caddy');
  }
}

main().catch(err => {
  console.error(`${RED}Error: ${err.message}${NC}`);
  process.exit(1);
});
