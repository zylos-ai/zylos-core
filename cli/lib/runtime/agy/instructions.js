import fs from 'node:fs';
import { ZYLOS_DIR } from '../../config.js';
import { instructionPathsFor } from '../shared/instruction-paths.js';

export const instructions = Object.freeze({
  template: 'codex',
  output: 'AGENTS.md',
  sessionStartInjection,
});

function sessionStartInjection({ zylosDir = ZYLOS_DIR } = {}) {
  const paths = instructionPathsFor(instructions, { zylosDir });
  const split = fs.existsSync(paths.markerPath);
  const system = fs.readFileSync(split ? paths.systemPath : paths.outputPath, 'utf8');
  const precedence = 'This injection contains the complete Zylos instructions. If its runtime-specific instructions conflict with AGENTS.md in the working directory, this injection takes precedence.\n\n';
  return precedence + (split ? [system, fs.readFileSync(paths.userPath, 'utf8')].join('\n\n') : system);
}
