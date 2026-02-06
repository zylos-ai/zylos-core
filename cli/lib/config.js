/**
 * Shared configuration constants
 */

import path from 'node:path';

export const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
export const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
export const CONFIG_DIR = path.join(ZYLOS_DIR, '.zylos');
export const COMPONENTS_DIR = path.join(ZYLOS_DIR, 'components');
export const LOCKS_DIR = path.join(CONFIG_DIR, 'locks');
export const REGISTRY_FILE = path.join(CONFIG_DIR, 'registry.json');
export const REGISTRY_URL = 'https://raw.githubusercontent.com/zylos-ai/zylos-registry/main/registry.json';
export const COMPONENTS_FILE = path.join(CONFIG_DIR, 'components.json');
