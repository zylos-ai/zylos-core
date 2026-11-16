import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const {runDownloadedUpgrade} = await import(pathToFileURL(path.join(input.installedRoot, 'cli/lib/upgrade-bridge.js')).href);
process.exitCode = runDownloadedUpgrade(input);
