import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';
import * as protection from '../upgrade-protection.js';
import * as selfUpgrade from '../self-upgrade.js';
import * as lock from '../lock.js';

const cliRoot = path.resolve(import.meta.dirname, '../..');

// Import complete historical modules unchanged, with external dependencies
// supplied at module boundaries. Private functions run through public entries.
function overlay(root, version) {
  const packageRoot = path.join(root, `frozen-package-${version}`);
  const lib = path.join(packageRoot, 'cli/lib');
  const commands = path.join(packageRoot, 'cli/commands');
  fs.mkdirSync(lib, {recursive:true});
  fs.mkdirSync(commands, {recursive:true});
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({type:'module',name:'frozen-upgrade-fixture'}));
  for (const entry of fs.readdirSync(path.join(cliRoot, 'lib'))) {
    if (['self-upgrade.js','sync-settings-hooks.js','config.js'].includes(entry)) continue;
    fs.symlinkSync(path.join(cliRoot, 'lib', entry), path.join(lib, entry));
  }
  fs.writeFileSync(path.join(lib, 'sync-settings-hooks.js'),
    `export {isCoreManaged} from ${JSON.stringify(pathToFileURL(path.join(cliRoot,'lib/sync-runtime-hooks.js')).href)};`);
  fs.writeFileSync(path.join(lib, 'config.js'),
    `export * from ${JSON.stringify(pathToFileURL(path.join(cliRoot,'lib/config.js')).href)};
     export const ZYLOS_DIR=${JSON.stringify(root)};
     export const SKILLS_DIR=${JSON.stringify(path.join(root,'.claude/skills'))};
     export const COMPONENTS_DIR=${JSON.stringify(path.join(root,'components'))};
     export function getZylosConfig(){return {runtime:'claude'};}`);
  const fixture = path.join(import.meta.dirname, 'fixtures', `upgrade-${version}`);
  fs.copyFileSync(path.join(fixture,'self-upgrade.js'),path.join(lib,'self-upgrade.js'));
  fs.copyFileSync(path.join(fixture,'component.js'),path.join(commands,'component.js'));
  return {packageRoot,lib,commands};
}

export async function frozenFinalizer(root, version, {spawnSync=childProcess.spawnSync, maintenance, finalizer, recover=()=>({attempted:false,recovery_required:true})} = {}) {
  const layout=overlay(root,version);
  const npmRoot=path.join(layout.packageRoot,'global');
  const target=path.join(npmRoot,'frozen-upgrade-fixture/cli/lib/self-upgrade-finalize.js');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,`import ${JSON.stringify(pathToFileURL(finalizer).href)};`);
  const mocks=[
    mock.module('node:child_process',{namedExports:{...childProcess,spawnSync,
      execSync:(command,options)=>command==='npm root -g'?npmRoot:childProcess.execSync(command,options)}}),
    mock.module(pathToFileURL(path.join(layout.lib,'upgrade-protection.js')).href,{namedExports:{...protection,
      maintenanceFor:ctx=>ctx.maintenance ?? maintenance ?? protection.maintenance,
      recovery:recover}}),
  ];
  let entry;
  try {entry=await import(pathToFileURL(path.join(layout.lib,'self-upgrade.js')).href);}
  finally {for(const item of mocks)item.restore();}
  return ctx=>entry.runSelfUpgrade({tempDir:root,newVersion:'target'}, {
    getCurrentVersion:()=>({success:true,version}),
    preInstallSteps:[actual=>{Object.assign(actual,ctx);return {step:1,status:'done'};}],
  });
}

export async function frozenComponent(root, version, dependencies) {
  const layout=overlay(root,version);
  const mocks=[
    mock.module(pathToFileURL(path.join(layout.lib,'self-upgrade.js')).href,{namedExports:{...selfUpgrade,...dependencies}}),
    mock.module(pathToFileURL(path.join(layout.lib,'lock.js')).href,{namedExports:{...lock,
      acquireLock:dependencies.acquireLock,releaseLock:dependencies.releaseLock}}),
  ];
  try {return await import(pathToFileURL(path.join(layout.commands,'component.js')).href);}
  finally {for(const item of mocks)item.restore();}
}
