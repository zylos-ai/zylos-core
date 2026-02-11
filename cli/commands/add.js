/**
 * zylos add - Install a component
 *
 * Terminal mode (default): Full interactive setup
 *   1. Resolve target → download → npm install → manifest → register
 *   2. Collect required config (prompt user) → write to .env
 *   3. Run post-install hook → start PM2 service
 *
 * JSON mode (--json): Mechanical installation only
 *   1. Resolve target → download → npm install → manifest → register
 *   2. Output SKILL.md metadata for Claude to handle config/hooks/service
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { SKILLS_DIR, COMPONENTS_DIR, BIN_DIR } from '../lib/config.js';
import { loadRegistry } from '../lib/registry.js';
import { loadComponents, saveComponents, resolveTarget, outputTask } from '../lib/components.js';
import { downloadArchive, downloadBranch } from '../lib/download.js';
import { generateManifest, saveManifest } from '../lib/manifest.js';
import { parseSkillMd, detectComponentType } from '../lib/skill.js';
import { linkBins } from '../lib/bin.js';
import { applyCaddyRoutes } from '../lib/caddy.js';
import { promptYesNo, prompt, promptSecret } from '../lib/prompts.js';
import { writeEnvEntries } from '../lib/env.js';
import { registerService } from '../lib/service.js';

/**
 * Main entry: zylos add <target> [--check] [--yes] [--json]
 */
export async function addComponent(args) {
  const skipConfirm = args.includes('--yes') || args.includes('-y');
  const jsonOutput = args.includes('--json');
  const checkOnly = args.includes('--check');
  const target = args.find(a => !a.startsWith('-'));

  if (!target) {
    printUsage();
    process.exit(1);
  }

  // 1. Resolve target
  const resolved = await resolveTarget(target);

  if (!resolved.repo) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        action: 'add_check', component: target, success: false,
        error: 'not_found', message: `Unknown component: ${target}`,
        reply: `Component "${target}" not found. Use "search <keyword>" to find available components.`,
      }, null, 2));
    } else {
      console.error(`Unknown component: ${target}`);
      console.log('Use "zylos search <keyword>" to find available components.');
    }
    process.exit(1);
  }

  // 2. Check if already installed
  const components = loadComponents();
  if (components[resolved.name]) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        action: 'add_check', component: resolved.name, success: true,
        alreadyInstalled: true, version: components[resolved.name].version,
        reply: `${resolved.name} is already installed (v${components[resolved.name].version}). Use "upgrade ${resolved.name}" to update.`,
      }, null, 2));
    } else {
      console.log(`Component "${resolved.name}" is already installed (v${components[resolved.name].version}).`);
      console.log('Use "zylos upgrade" to update.');
    }
    process.exit(0);
  }

  // 3. Gather component info from registry
  const registry = await loadRegistry();
  const regInfo = registry[resolved.name] || {};

  // 4. Check-only mode: show component info without installing
  if (checkOnly) {
    if (jsonOutput) {
      const output = {
        action: 'add_check', component: resolved.name, success: true,
        alreadyInstalled: false,
        version: resolved.version || regInfo.version || 'latest',
        description: regInfo.description || null,
        type: regInfo.type || null,
        repo: resolved.repo,
        isThirdParty: resolved.isThirdParty || false,
      };
      let reply = `${resolved.name}`;
      if (output.version && output.version !== 'latest') reply += ` (v${output.version})`;
      else if (output.version === 'latest') reply += ` (latest)`;
      if (regInfo.description) reply += `\n${regInfo.description}`;
      reply += `\nType: ${regInfo.type || 'unknown'}`;
      reply += `\nRepo: ${resolved.repo}`;
      if (resolved.isThirdParty) reply += '\nWarning: Third-party component';
      const confirmTarget = resolved.version ? `${resolved.name}@${resolved.version}` : resolved.name;
      reply += `\n\nReply "add ${confirmTarget} confirm" to install.`;
      output.reply = reply;
      console.log(JSON.stringify(output, null, 2));
    } else {
      const versionInfo = resolved.version ? `@${resolved.version}` : ' (latest)';
      console.log(`\nComponent: ${resolved.name}${versionInfo}`);
      console.log(`Repository: https://github.com/${resolved.repo}`);
      if (resolved.isThirdParty) {
        console.log('Warning: Third-party component — not verified by Zylos team.');
      }
      if (regInfo.description) console.log(`Description: ${regInfo.description}`);
      if (regInfo.type) console.log(`Type: ${regInfo.type}`);
      const installTarget = resolved.version ? `${resolved.name}@${resolved.version}` : resolved.name;
      console.log(`\nRun "zylos add ${installTarget} --yes" to install.`);
    }
    return;
  }

  // 5. Display component info (terminal only)
  if (!jsonOutput) {
    const versionInfo = resolved.version ? `@${resolved.version}` : ' (latest)';
    console.log(`\nComponent: ${resolved.name}${versionInfo}`);
    console.log(`Repository: https://github.com/${resolved.repo}`);

    if (resolved.isThirdParty) {
      console.log('Warning: Third-party component — not verified by Zylos team.');
    }

    if (regInfo.description) console.log(`Description: ${regInfo.description}`);
    if (regInfo.type) console.log(`Type: ${regInfo.type}`);
  }

  // 6. User confirmation (skip in JSON mode — confirmation handled at application layer)
  if (!skipConfirm && !jsonOutput) {
    console.log('');
    const confirmed = await promptYesNo('Proceed with installation? [Y/n]: ', true);
    if (!confirmed) {
      console.log('Installation cancelled.');
      return;
    }
  }

  // 7. Download
  const skillDir = path.join(SKILLS_DIR, resolved.name);

  if (fs.existsSync(skillDir)) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        action: 'add', component: resolved.name, success: false,
        error: 'skill_dir_exists', message: `Skill directory already exists: ${skillDir}. Remove it first or use "zylos upgrade".`,
        reply: `Cannot install ${resolved.name}: skill directory already exists. Use "upgrade ${resolved.name}" instead.`,
      }, null, 2));
    } else {
      console.error(`\nSkill directory already exists: ${skillDir}`);
      console.error('Remove it first or use "zylos upgrade".');
    }
    process.exit(1);
  }

  if (!jsonOutput) console.log(`\nDownloading ${resolved.name}...`);

  let downloadResult;
  if (resolved.version) {
    downloadResult = downloadArchive(resolved.repo, resolved.version, skillDir);
  } else {
    downloadResult = downloadBranch(resolved.repo, 'main', skillDir);
  }

  if (!downloadResult.success) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        action: 'add', component: resolved.name, success: false,
        error: 'download_failed', message: `Download failed: ${downloadResult.error}`,
        reply: `Failed to download ${resolved.name}: ${downloadResult.error}`,
      }, null, 2));
    } else {
      console.error(`Download failed: ${downloadResult.error}`);
    }
    cleanup(skillDir);
    process.exit(1);
  }

  if (!jsonOutput) console.log('  Download complete.');

  // 8. Generate manifest
  try {
    const manifest = generateManifest(skillDir);
    saveManifest(skillDir, manifest);
  } catch (err) {
    if (!jsonOutput) console.log(`  Warning: Could not generate manifest: ${err.message}`);
  }

  // 9. Detect component type and install accordingly
  const componentType = detectComponentType(skillDir);

  if (componentType === 'declarative') {
    await installDeclarative(resolved, skillDir, skipConfirm, jsonOutput);
  } else {
    installAI(resolved, skillDir);
  }
}

/**
 * Install a declarative component (has SKILL.md).
 * Terminal mode: full interactive setup (config → hooks → service start).
 * JSON mode: mechanical install only, outputs metadata for Claude.
 */
async function installDeclarative(resolved, skillDir, skipConfirm, jsonOutput) {
  if (!jsonOutput) console.log('\nInstalling (declarative)...');

  const skill = parseSkillMd(skillDir);
  const fm = skill?.frontmatter || {};
  const lifecycle = fm.lifecycle || {};
  const config = fm.config || {};
  const hooks = lifecycle.hooks || {};

  // Resolve version: prefer resolved tag, then SKILL.md frontmatter, then package.json
  const componentVersion = resolved.version
    || fm.version
    || (() => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(skillDir, 'package.json'), 'utf8'));
        return pkg.version;
      } catch { return null; }
    })()
    || '0.0.0';

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
          console.log(JSON.stringify({
            action: 'add', component: resolved.name, success: false,
            error: 'npm_install_failed', message: `npm install failed: ${err.message}`,
            reply: `Failed to install ${resolved.name}: npm install failed.`,
          }, null, 2));
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
    version: componentVersion,
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
    // Ensure BIN_DIR is in current process PATH so post-install hooks
    // and services can find newly created bin commands
    if (!(process.env.PATH || '').split(':').includes(BIN_DIR)) {
      process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;
    }
  }

  // Step 5: Apply Caddy routes (if declared)
  const httpRoutes = fm.http_routes || fm['http_routes'];
  let caddyResult = null;
  if (httpRoutes && Array.isArray(httpRoutes) && httpRoutes.length > 0) {
    caddyResult = applyCaddyRoutes(resolved.name, httpRoutes);
    if (!jsonOutput) {
      if (caddyResult.success) {
        console.log(`  Caddy routes: ${caddyResult.action}`);
      } else {
        console.log(`  Caddy routes: failed (${caddyResult.error})`);
      }
    }
  }

  // JSON mode: output metadata for Claude to handle
  if (jsonOutput) {
    const requiredConfig = config.required;
    let reply = `${resolved.name} installed (v${componentVersion})`;
    if (Array.isArray(requiredConfig) && requiredConfig.length > 0) {
      const names = requiredConfig.map(c => typeof c === 'string' ? c : c.name);
      reply += `\nRequired config: ${names.join(', ')}`;
    }
    if (fm['next-steps'] || fm.nextSteps) {
      reply += `\nNext: ${fm['next-steps'] || fm.nextSteps}`;
    }
    const output = {
      action: 'add',
      component: resolved.name,
      success: true,
      version: componentVersion,
      skillDir,
      dataDir,
      skill: {
        hooks: Object.keys(hooks).length > 0 ? hooks : null,
        config: Object.keys(config).length > 0 ? config : null,
        service: lifecycle.service || null,
        bin: binResult || null,
        caddy: caddyResult,
        nextSteps: fm['next-steps'] || fm.nextSteps || null,
      },
      reply,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Terminal mode: interactive setup

  // Step 6: Collect required configuration
  const requiredConfig = config.required;
  if (Array.isArray(requiredConfig) && requiredConfig.length > 0) {
    console.log('\nConfiguration:');
    const envEntries = {};

    for (const item of requiredConfig) {
      const name = typeof item === 'string' ? item : item.name;
      const desc = typeof item === 'string' ? '' : item.description || '';
      const sensitive = typeof item === 'string' ? false : item.sensitive === true;

      const hint = desc ? ` (${desc})` : '';
      let value;
      if (sensitive) {
        value = await promptSecret(`  ${name}${hint}: `);
      } else {
        value = await prompt(`  ${name}${hint}: `);
      }
      if (value) {
        envEntries[name] = value;
      }
    }

    if (Object.keys(envEntries).length > 0) {
      const envResult = writeEnvEntries(envEntries, resolved.name);
      if (envResult.written.length > 0) {
        console.log(`  ✓ Saved ${envResult.written.length} variable(s) to .env`);
      }
      if (envResult.skipped.length > 0) {
        console.log(`  Skipped existing: ${envResult.skipped.join(', ')}`);
      }
    }
  }

  // Step 7: Run post-install hook
  if (hooks['post-install']) {
    const hookPath = path.resolve(skillDir, hooks['post-install']);
    if (fs.existsSync(hookPath)) {
      console.log('  Running post-install hook...');
      try {
        execSync(`node "${hookPath}"`, {
          cwd: skillDir,
          stdio: 'inherit',
          timeout: 120000,
        });
        console.log('  ✓ Post-install hook complete.');
      } catch {
        console.log('  ⚠ Post-install hook had issues (non-fatal).');
      }
    }
  }

  // Step 8: Start service
  const service = lifecycle.service;
  if (service && service.entry) {
    console.log('\nStarting service...');
    const svcResult = registerService({
      name: resolved.name,
      entry: service.entry,
      skillDir,
      type: service.type || 'pm2',
    });
    if (svcResult.success) {
      console.log(`  ✓ ${service.name || ('zylos-' + resolved.name)} started`);
    } else {
      console.log(`  ✗ Failed to start service: ${svcResult.error}`);
      console.log('  You can start it manually later.');
    }
  }

  console.log(`\n✓ ${resolved.name} installed successfully!`);

  // Show PATH hint if bin commands were linked
  if (binResult && Object.keys(binResult).length > 0) {
    const cmds = Object.keys(binResult).join(', ');
    console.log(`\nNote: Run the following to use ${cmds} in this terminal:`);
    console.log('  export PATH="$HOME/zylos/bin:$PATH"');
    console.log('Or restart your terminal for the change to take effect.');
  }
}

/**
 * Install an AI component (no SKILL.md — needs Claude to finish setup).
 */
function installAI(resolved, skillDir) {
  console.log('\nInstalling (AI mode — Claude will complete setup)...');

  // Resolve version from SKILL.md or package.json when not from a tag
  const aiVersion = resolved.version
    || (() => {
      try {
        const skill = parseSkillMd(skillDir);
        return skill?.frontmatter?.version;
      } catch { return null; }
    })()
    || (() => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(skillDir, 'package.json'), 'utf8'));
        return pkg.version;
      } catch { return null; }
    })()
    || '0.0.0';

  // Update components.json with basic info
  const components = loadComponents();
  components[resolved.name] = {
    version: aiVersion,
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
  --check    Show component info without installing
  --yes, -y  Skip confirmation prompts
  --json     Output in JSON format (for programmatic use)

Examples:
  zylos add telegram              Official component (latest)
  zylos add telegram@0.2.0        Specific version
  zylos add user/my-component     Third-party
  zylos add https://github.com/user/zylos-my-component`);
}
