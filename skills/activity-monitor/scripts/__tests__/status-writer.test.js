import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicHealth } from '../status-writer.js';
test('public health normalizes non-public internal states',()=>{
 for(const health of ['ok','rate_limited','auth_failed'])assert.equal(publicHealth(health),health);
 for(const health of ['recovering','down','unavailable'])assert.equal(publicHealth(health),'unavailable');
});
