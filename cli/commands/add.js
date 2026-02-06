/**
 * zylos add - Install a component
 *
 * Full self-contained installation flow:
 *   1. Resolve target → download → detect type
 *   2. Declarative (SKILL.md): npm install, config, hook, PM2, done
 *   3. AI (no SKILL.md): record in components.json, output task for Claude
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ZYLOS_DIR, SKILLS_DIR, COMPONENTS_DIR } from '../lib/config.js';
import { loadRegistry } from '../lib/registry.js';
import { loadComponents, saveComponents, resolveTarget, outputTask } from '../lib/components.js';
import { downloadArchive, downloadBranch } from '../lib/download.js';
import { generateManifest, saveManifest } from '../lib/manifest.js';
import { parseSkillMd, detectComponentType } from '../lib/skill.js';
import { readEnvFile, writeEnvEntries } from '../lib/env.js';
import { registerService } from '../lib/service.js';
import { prompt, promptYesNo, promptSecret } from '../lib/prompts.js';

/**
 * Main entry: zylos add <target> [--yes]
 */
export async function addComponent(args) {
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const target = args.find(a => !a.startsWith('-'));

  if (!target) {
    printUsage();
    process.exit(1);
  }

  // 1. Resolve target
  const resolved = await resolveTarget(target);

  if (!resolved.repo) {
    console.error(`Unknown component: ${target}`);
    console.log('Use "zylos search <keyword>" to find available components.');
    process.exit(1);
  }

  // 2. Check if already installed
  const components = loadComponents();
  if (components[resolved.name]) {
    console.log(`Component "${resolved.name}" is already installed (v${components[resolved.name].version}).`);
    console.log('Use "zylos upgrade" to update.');
    process.exit(0);
  }

  // 3. Display component info
  const versionInfo = resolved.version ? `@${resolved.version}` : ' (latest)';
  console.log(`\nComponent: ${resolved.name}${versionInfo}`);
  console.log(`Repository: https://github.com/${resolved.repo}`);

  if (resolved.isThirdParty) {
    console.log('Warning: Third-party component — not verified by Zylos team.');
  }

  // Try to get description from registry
  const registry = await loadRegistry();
  if (registry[resolved.name]) {
    console.log(`Description: ${registry[resolved.name].description}`);
    console.log(`Type: ${registry[resolved.name].type}`);
  }

  // 4. User confirmation
  if (!skipConfirm) {
    console.log('');
    const confirmed = await promptYesNo('Proceed with installation? [Y/n]: ', true);
    if (!confirmed) {
      console.log('Installation cancelled.');
      return;
    }
  }

  // 5. Download
  const skillDir = path.join(SKILLS_DIR, resolved.name);

  if (fs.existsSync(skillDir)) {
    console.error(`\nSkill directory already exists: ${skillDir}`);
    console.error('Remove it first or use "zylos upgrade".');
    process.exit(1);
  }

  console.log(`\nDownloading ${resolved.name}...`);

  let downloadResult;
  if (resolved.version) {
    downloadResult = downloadArchive(resolved.repo, resolved.version, skillDir);
  } else {
    downloadResult = downloadBranch(resolved.repo, 'main', skillDir);
  }

  if (!downloadResult.success) {
    console.error(`Download failed: ${downloadResult.error}`);
    cleanup(skillDir);
    process.exit(1);
  }

  console.log('  Download complete.');

  // 6. Generate manifest
  try {
    const manifest = generateManifest(skillDir);
    saveManifest(skillDir, manifest);
  } catch (err) {
    console.log(`  Warning: Could not generate manifest: ${err.message}`);
  }

  // 7. Detect component type and install accordingly
  const componentType = detectComponentType(skillDir);

  if (componentType === 'declarative') {
    await installDeclarative(resolved, skillDir, skipConfirm);
  } else {
    installAI(resolved, skillDir);
  }
}

/**
 * Install a declarative component (has SKILL.md).
 */
async function installDeclarative(resolved, skillDir, skipConfirm) {
  console.log('\nInstalling (declarative)...');

  const skill = parseSkillMd(skillDir);
  const fm = skill?.frontmatter || {};
  const lifecycle = fm.lifecycle || {};
  const config = fm.config || {};

  // Step 1: npm install
  if (lifecycle.npm) {
    const pkgJson = path.join(skillDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      console.log('  Installing npm dependencies...');
      try {
        execSync('npm install --omit=dev', {
          cwd: skillDir,
          stdio: 'pipe',
          timeout: 120000,
        });
        console.log('  npm install complete.');
      } catch (err) {
        console.error(`  npm install failed: ${err.message}`);
        cleanup(skillDir);
        process.exit(1);
      }
    }
  }

  // Step 2: Create data directory
  const dataDir = path.join(COMPONENTS_DIR, resolved.name);
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`  Data directory: ${dataDir}`);

  // Step 3: Collect config interactively
  const requiredConfig = config.required || [];
  if (requiredConfig.length > 0) {
    console.log('\n  Configuration required:');

    if (skipConfirm) {
      // In non-interactive mode, write placeholders
      console.log('  (--yes mode: skipping prompts, set these manually in .env)');
      const entries = {};
      for (const item of requiredConfig) {
        const key = typeof item === 'string' ? item : item.name;
        if (key) {
          entries[key] = '';
        }
      }
      const result = writeEnvEntries(entries, resolved.name);
      if (result.written.length > 0) {
        console.log(`  Keys to configure: ${result.written.join(', ')}`);
      }
    } else {
      const entries = {};
      const existing = readEnvFile();
      for (const item of requiredConfig) {
        const key = typeof item === 'string' ? item : item.name;
        const desc = typeof item === 'string' ? item : (item.description || item.name);
        const secret = typeof item === 'object' && item.sensitive;

        if (!key) continue;

        // Check if already set
        if (existing.has(key)) {
          console.log(`  ${key}: already set (skipping)`);
          continue;
        }

        let value;
        if (secret) {
          value = await promptSecret(`  ${desc}: `);
        } else {
          value = await prompt(`  ${desc}: `);
        }

        if (value) {
          entries[key] = value;
        }
      }

      if (Object.keys(entries).length > 0) {
        const result = writeEnvEntries(entries, resolved.name);
        if (result.written.length > 0) {
          console.log(`\n  Saved ${result.written.length} config value(s) to .env`);
        }
      }
    }
  }

  // Step 4: Execute post-install hook
  const hooks = lifecycle.hooks || {};
  const postInstall = hooks['post-install'];
  if (postInstall) {
    console.log('  Running post-install hook...');
    try {
      executeHook(postInstall, skillDir);
      console.log('  Post-install hook complete.');
    } catch (err) {
      console.log(`  Warning: Post-install hook failed: ${err.message}`);
      // Don't abort — warn only
    }
  }

  // Step 5: Register PM2 service
  const service = lifecycle.service;
  if (service && service.entry) {
    console.log('  Starting service...');
    const svcResult = registerService({
      name: resolved.name,
      entry: service.entry,
      skillDir,
      type: service.type || 'pm2',
    });

    if (svcResult.success) {
      console.log(`  Service "zylos-${resolved.name}" started.`);
    } else {
      console.log(`  Warning: Service start failed: ${svcResult.error}`);
    }
  }

  // Step 6: Update components.json
  const components = loadComponents();
  components[resolved.name] = {
    version: resolved.version || '0.0.0',
    repo: resolved.repo,
    type: 'declarative',
    isThirdParty: resolved.isThirdParty,
    installedAt: new Date().toISOString(),
    skillDir,
    dataDir,
  };
  saveComponents(components);

  // Done
  console.log(`\n✓ ${resolved.name} installed successfully!`);

  // Display next steps from SKILL.md
  const nextSteps = fm['next-steps'] || fm.nextSteps;
  if (nextSteps && Array.isArray(nextSteps)) {
    console.log('\nNext steps:');
    for (const step of nextSteps) {
      console.log(`  - ${step}`);
    }
  }

  console.log('');
}

/**
 * Install an AI component (no SKILL.md — needs Claude to finish setup).
 */
function installAI(resolved, skillDir) {
  console.log('\nInstalling (AI mode — Claude will complete setup)...');

  // Update components.json with basic info
  const components = loadComponents();
  components[resolved.name] = {
    version: resolved.version || '0.0.0',
    repo: resolved.repo,
    type: 'ai',
    isThirdParty: resolved.isThirdParty,
    installedAt: new Date().toISOString(),
    skillDir,
    setupComplete: false,
  };
  saveComponents(components);

  // Output task for Claude to read README and finish setup
  outputTask('install', {
    component: resolved.name,
    repo: resolved.repo,
    version: resolved.version,
    skillDir,
    dataDir: path.join(COMPONENTS_DIR, resolved.name),
    isThirdParty: resolved.isThirdParty,
    steps: [
      `Read README.md in ${skillDir} for setup instructions`,
      `Create data directory ${COMPONENTS_DIR}/${resolved.name} if needed`,
      `Install npm dependencies if package.json exists`,
      `Configure environment variables as needed`,
      `Register PM2 service if applicable`,
      `Update components.json setupComplete to true when done`,
    ],
  });
}

/**
 * Execute a post-install hook script.
 * Detects .js vs .sh by extension.
 */
function executeHook(hookPath, cwd) {
  const resolved = path.resolve(cwd, hookPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Hook script not found: ${resolved}`);
  }

  const ext = path.extname(resolved);
  let cmd;
  if (ext === '.js' || ext === '.mjs') {
    cmd = `node "${resolved}"`;
  } else if (ext === '.sh') {
    cmd = `bash "${resolved}"`;
  } else {
    cmd = `"${resolved}"`;
  }

  execSync(cmd, {
    cwd,
    stdio: 'inherit',
    timeout: 60000,
    env: { ...process.env, ZYLOS_DIR, SKILLS_DIR, COMPONENTS_DIR },
  });
}

/**
 * Clean up a failed installation.
 */
function cleanup(dir) {
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
}

function printUsage() {
  console.log(`Usage: zylos add <target> [options]

Arguments:
  target    Component name, org/repo, or GitHub URL

Options:
  --yes, -y  Skip confirmation prompts

Examples:
  zylos add telegram              Official component (latest)
  zylos add telegram@0.2.0        Specific version
  zylos add user/my-component     Third-party
  zylos add https://github.com/user/zylos-my-component`);
}
