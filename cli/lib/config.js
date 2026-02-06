/**
 * Shared configuration constants
 */

const path = require('path');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
const CONFIG_DIR = path.join(ZYLOS_DIR, '.zylos');
const COMPONENTS_DIR = path.join(ZYLOS_DIR, 'components');
const LOCKS_DIR = path.join(CONFIG_DIR, 'locks');
const REGISTRY_FILE = path.join(CONFIG_DIR, 'registry.json');
const REGISTRY_URL = 'https://raw.githubusercontent.com/zylos-ai/zylos-registry/main/registry.json';
const COMPONENTS_FILE = path.join(CONFIG_DIR, 'components.json');

module.exports = {
  ZYLOS_DIR,
  SKILLS_DIR,
  CONFIG_DIR,
  COMPONENTS_DIR,
  LOCKS_DIR,
  REGISTRY_FILE,
  REGISTRY_URL,
  COMPONENTS_FILE,
};
