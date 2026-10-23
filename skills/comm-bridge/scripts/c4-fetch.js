#!/usr/bin/env node
import { runCli } from './c4-public-cli.js';
runCli('fetch', process.argv.slice(2));
