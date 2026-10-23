#!/usr/bin/env node
// Explicit build step only: never downloads tools or runs from runtime code.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

if (process.platform !== 'linux') throw new Error('The pidfd helper targets Linux only');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=process.argv[2];
if (!output || process.argv.length!==3) throw new Error('Usage: node scripts/build-process-signal.js OUTPUT');
const destination=path.resolve(output);
fs.mkdirSync(path.dirname(destination), {recursive:true});
// A compiler path is a build input, never a runtime shell command.
const result=spawnSync(process.env.CC || 'cc', ['-std=c11','-O2','-Wall','-Wextra','-Werror',
  '-o',destination,path.join(root,'cli/lib/runtime/native/pidfd-signal.c')], {stdio:'inherit'});
if (result.error) throw result.error;
if (result.status!==0) throw new Error(`pidfd helper compilation failed: ${result.status}`);
fs.chmodSync(destination,0o755);
