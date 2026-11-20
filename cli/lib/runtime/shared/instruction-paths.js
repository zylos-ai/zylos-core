import fs from 'node:fs';
import path from 'node:path';
import { ZYLOS_DIR } from '../../config.js';
import { assembleInstruction, needsRebuild } from '../assembler.mjs';

export function instructionAssetPaths({ zylosDir = ZYLOS_DIR } = {}) {
  const root = path.resolve(zylosDir);
  const instructionsDir = path.join(root, '.zylos', 'instructions');
  return {
    instructionsDir,
    markerPath: path.join(instructionsDir, 'meta.json'),
    assemblerPath: path.join(instructionsDir, 'assembler.mjs'),
    userPath: path.join(root, 'ZYLOS.md'),
  };
}

export function instructionPathsFor({ template, output }, { zylosDir = ZYLOS_DIR } = {}) {
  const assets = instructionAssetPaths({ zylosDir });
  return {
    ...assets,
    systemPath: path.join(assets.instructionsDir, `${template}-system.md`),
    outputPath: path.resolve(zylosDir, output),
  };
}

export function buildInstructionFor(declaration, { zylosDir = ZYLOS_DIR, force = false } = {}) {
  const paths = instructionPathsFor(declaration, { zylosDir });
  if (!fs.existsSync(paths.markerPath)) return paths.outputPath;
  if (force || needsRebuild(paths)) assembleInstruction(paths);
  return paths.outputPath;
}
