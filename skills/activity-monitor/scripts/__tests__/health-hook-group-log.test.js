import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectHealthHook } from '../hook-health.js';
import { EventLogReader } from '../../../../cli/lib/event-log.js';
import { groupRunDir, RUN_FILES } from '../../../../cli/lib/session-group-paths.js';

test('T02/T08 F6 health hook writes group/run identity with unchanged receipt time and no singleton stream',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hook-group-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const env={ZYLOS_DIR:root,ZYLOS_SESSION_GROUP:'telegram:a',ZYLOS_RUN_ID:'11111111-1111-4111-8111-111111111111'};
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',error:'rate_limit'}, {zylosDir:root,nowMs:123456,pid:42,env});
  const reader=new EventLogReader(path.join(groupRunDir('telegram:a',env),RUN_FILES.EVENTS));t.after(()=>reader.close());
  assert.deepEqual(reader.read(),[event]);assert.equal(event.v,1);assert.equal(event.session_group,'telegram:a');assert.equal(event.run_id,env.ZYLOS_RUN_ID);assert.equal(event.received_at,123456);assert.equal(event.ts,123456);
  assert.equal(fs.existsSync(path.join(root,'activity-monitor','tool-events.jsonl')),false);
});
