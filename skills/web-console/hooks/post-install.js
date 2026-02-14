#!/usr/bin/env node

/**
 * Web Console post-install hook.
 * - Generates a random password and writes it to .env
 * - Prints access URL (if domain is configured)
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || join(homedir(), 'zylos');
const ENV_FILE = join(ZYLOS_DIR, '.env');
const CONFIG_FILE = join(ZYLOS_DIR, '.zylos', 'config.json');
const KEY = 'WEB_CONSOLE_PASSWORD';

// --- Password generation ---

let password;

// Read existing .env or start fresh
let content = '';
if (existsSync(ENV_FILE)) {
  content = readFileSync(ENV_FILE, 'utf-8');
}

// Check if password is already set
const regex = new RegExp(`^${KEY}=(.+)`, 'm');
const match = content.match(regex);
if (match) {
  password = match[1].trim();
  console.log(`  ${KEY} already set in .env, keeping existing value.`);
} else {
  // Generate a 16-char alphanumeric password
  password = randomBytes(12).toString('base64url').slice(0, 16);
  const entry = `\n# Web Console password (auto-generated)\n${KEY}=${password}\n`;
  writeFileSync(ENV_FILE, content.trimEnd() + entry);
}

// --- Print summary ---

console.log(`  Password: ${password}`);

// Show access URL if domain is configured
try {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  if (config.domain) {
    const proto = config.protocol || 'https';
    console.log(`  URL: ${proto}://${config.domain}/console/`);
  }
} catch {
  // No config yet — skip URL display
}
