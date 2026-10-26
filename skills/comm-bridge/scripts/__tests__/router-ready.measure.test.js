import test from 'node:test';
import {measure} from './router-ready.measure.js';
for(const runtime of ['claude','codex'])test(`real ${runtime} READY measurement preflight`,async t=>measure(t,runtime));
