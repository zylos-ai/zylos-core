/**
 * Shared configuration constants
 */

const path = require('path');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const SKILLS_DIR = path.join(process.env.HOME, '.claude', 'skills');
const COMPONENTS_DIR = path.join(ZYLOS_DIR, 'components');
const REGISTRY_FILE = path.join(__dirname, '..', 'registry.json');
const REGISTRY_URL = 'https://raw.githubusercontent.com/zylos-ai/zylos-registry/main/registry.json';

module.exports = {
  ZYLOS_DIR,
  SKILLS_DIR,
  COMPONENTS_DIR,
  REGISTRY_FILE,
  REGISTRY_URL,
};
