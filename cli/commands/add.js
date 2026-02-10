/**
 * zylos add - Install a component
 *
 * Mechanical installation only:
 *   1. Resolve target → download → npm install → manifest → register
 *   2. Output SKILL.md metadata (config schema, hooks, service info)
 *   3. Claude handles: config collection, hook execution, service start, user guidance
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { SKILLS_DIR, COMPONENTS_DIR } from '../lib/config.js';
import { loadRegistry } from '../lib/registry.js';
import { loadComponents, saveComponents, resolveTarget, outputTask } from '../lib/components.js';
import { downloadArchive, downloadBranch } from '../lib/download.js';
import { generateManifest, saveManifest } from '../lib/manifest.js';
import { parseSkillMd, detectComponentType } from '../lib/skill.js';
import { linkBins } from '../lib/bin.js';
import { promptYesNo } from '../lib/prompts.js';

/**
 * Main entry: zylos add <target> [--yes]
 */
export async function addComponent(args) {
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const jsonOutput = args.includes('--json');
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
    await installDeclarative(resolved, skillDir, skipConfirm, jsonOutput);
  } else {
    installAI(resolved, skillDir);
  }
}

/**
 * Install a declarative component (has SKILL.md).
 * Only handles mechanical operations. Claude handles config, hooks, service start.
 */
async function installDeclarative(resolved, skillDir, skipConfirm, jsonOutput) {
  if (!jsonOutput) console.log('\nInstalling (declarative)...');

  const skill = parseSkillMd(skillDir);
  const fm = skill?.frontmatter || {};
  const lifecycle = fm.lifecycle || {};
  const config = fm.config || {};
  const hooks = lifecycle.hooks || {};

  // Step 1: npm install
  if (lifecycle.npm) {
    const pkgJson = path.join(skillDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      if (!jsonOutput) console.log('  Installing npm dependencies...');
      try {
        execSync('npm install --omit=dev', {
          cwd: skillDir,
          stdio: 'pipe',
          timeout: 120000,
        });
        if (!jsonOutput) console.log('  npm install complete.');
      } catch (err) {
        if (jsonOutput) {
          console.log(JSON.stringify({ action: 'add', component: resolved.name, success: false, error: `npm install failed: ${err.message}` }));
        } else {
          console.error(`  npm install failed: ${err.message}`);
        }
        cleanup(skillDir);
        process.exit(1);
      }
    }
  }

  // Step 2: Create data directory
  const dataDir = path.join(COMPONENTS_DIR, resolved.name);
  fs.mkdirSync(dataDir, { recursive: true });
  if (!jsonOutput) console.log(`  Data directory: ${dataDir}`);

  // Step 3: Update components.json
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

  // Step 4: Create bin symlinks
  const binResult = linkBins(skillDir, fm.bin);
  if (binResult) {
    components[resolved.name].bin = binResult;
    saveComponents(components);
    if (!jsonOutput) {
      for (const cmd of Object.keys(binResult)) {
        console.log(`  CLI command: ${cmd}`);
      }
    }
  }

  // Output result
  if (jsonOutput) {
    const output = {
      action: 'add',
      component: resolved.name,
      success: true,
      version: resolved.version || '0.0.0',
      skillDir,
      dataDir,
      skill: {
        hooks: Object.keys(hooks).length > 0 ? hooks : null,
        config: Object.keys(config).length > 0 ? config : null,
        service: lifecycle.service || null,
        bin: binResult || null,
        nextSteps: fm['next-steps'] || fm.nextSteps || null,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n✓ ${resolved.name} code installed successfully!`);
    console.log('  Claude will now collect configuration and start the service.');
  }
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
  --json     Output in JSON format (for programmatic use)

Examples:
  zylos add telegram              Official component (latest)
  zylos add telegram@0.2.0        Specific version
  zylos add user/my-component     Third-party
  zylos add https://github.com/user/zylos-my-component`);
}
