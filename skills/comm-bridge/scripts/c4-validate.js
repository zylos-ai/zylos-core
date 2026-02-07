import fs from 'fs';
import path from 'path';
import { SKILLS_DIR } from './c4-config.js';

export function validateChannel(channel, requirePath) {
  if (requirePath) {
    if (channel.includes('..') || channel.includes('/')) {
      throw new Error('Invalid channel name: path traversal detected');
    }

    const skillsDir = path.resolve(SKILLS_DIR);
    const resolved = path.resolve(skillsDir, channel);

    if (!resolved.startsWith(skillsDir + path.sep)) {
      throw new Error('Invalid channel name: resolved path escapes skills directory');
    }

    const stats = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stats || !stats.isDirectory()) {
      throw new Error(`Invalid channel name: directory not found (${channel})`);
    }
  }

  return channel;
}

export function validateEndpoint(endpoint) {
  if (!/^[a-zA-Z0-9_-]+$/.test(endpoint)) {
    throw new Error(`Invalid endpoint: ${endpoint}`);
  }

  return endpoint;
}
