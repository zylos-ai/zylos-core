/**
 * SKILL.md parser
 *
 * Extracts YAML frontmatter from SKILL.md files and detects component type.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * Parse SKILL.md from a component directory.
 * Extracts YAML frontmatter (between --- delimiters) and returns parsed object.
 *
 * @param {string} dir - Component directory containing SKILL.md
 * @returns {{ frontmatter: object, body: string } | null} null if no SKILL.md found
 */
export function parseSkillMd(dir) {
  const skillPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;

  const content = fs.readFileSync(skillPath, 'utf8');

  // Extract YAML frontmatter between --- delimiters
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { frontmatter: {}, body: content };
  }

  try {
    const frontmatter = yaml.load(fmMatch[1], { schema: yaml.JSON_SCHEMA }) || {};
    const body = content.slice(fmMatch[0].length).trim();
    return { frontmatter, body };
  } catch (err) {
    console.log(`Warning: Failed to parse SKILL.md frontmatter: ${err.message}`);
    return { frontmatter: {}, body: content };
  }
}

/**
 * Detect the component type based on directory contents.
 *
 * - 'declarative': Has SKILL.md with frontmatter (self-contained install)
 * - 'ai': No SKILL.md (needs Claude to read README and finish setup)
 *
 * @param {string} dir - Component directory
 * @returns {'declarative' | 'ai'}
 */
export function detectComponentType(dir) {
  const skillPath = path.join(dir, 'SKILL.md');
  return fs.existsSync(skillPath) ? 'declarative' : 'ai';
}
