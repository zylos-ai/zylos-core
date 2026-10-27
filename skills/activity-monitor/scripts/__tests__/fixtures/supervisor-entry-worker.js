import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [entry, scenario] = process.argv.slice(2);
const { startSupervisor } = await import(pathToFileURL(entry).href);
const logs=[];let noticeScope;
const database={getDb:()=>({prepare:()=>({get:scope=>{noticeScope=scope;return {id:1,channel:'fake',endpoint_id:'frozen'};}})}),getModeTransition:()=>null,listDrainFences:()=>[],getDrainFence:()=>null,
  listPendingSessionGroups:()=>[],getControlById:()=>null,
  resolveSessionLaunchConfig:()=>({runtime:'claude',mode:'default'})};
const scenes={observe:async()=>[],readIdentity(group) { return this.observeGroup(group); }, observeGroup:async()=>({present:false}),listRuns:async()=>[],readRun:async()=>null};
const options={db:database,scenes,legacyStatus:{tick(){},close(){}},log:value=>logs.push(value),machineTasks:{tick(){},stop(){}},
  sendAlert:()=>{throw new Error('external send forbidden');},
  loopOptions:{intervalMs:10000}};
if(scenario==='missing-migration')options.advanceAutomaticMigration=()=>{throw Object.assign(new Error('fixture missing migration owner'),{code:'DEPENDENCY_UNAVAILABLE'});};
if(scenario==='restore-failure')options.requestStore={read(){throw Object.assign(new Error('fixture restore failure'),{code:'RESTORE_FAILED'});}};
let service;
try {
  service=await startSupervisor(options);
  process.send({ready:true,admissionOpen:service.supervisor.admission.open,configurationError:service.supervisor.loop.configurationError?.code,mode:service.supervisor.loop.configuration?.mode,legacy:service.supervisor.loop.configuration?.legacy,logs});
} catch(error) {
  process.send({startupError:error.code ?? error.message});process.disconnect();
}
process.on('message',async message=>{
  if(message==='stop') {
    try {await service.stop();await service.stop();process.send({stopped:true});process.disconnect();}
    catch(error){process.send({stopError:error.code ?? error.message});process.exitCode=1;process.disconnect();}
  }
  if(message==='rounds') {for(let i=0;i<6;i++)await service.supervisor.loop.runRound();process.send({logs,configuration:service.supervisor.loop.configuration});}
  if(message==='freeze') {
    const store=service.supervisor.health.store('claude');
    const identity={runtime:'claude',session_id:'fixture-session',claude_pid:123};
    store.consume({schema_version:1,source:'hook',runtime:'claude',event_id:randomUUID(),session_id:identity.session_id,
      claude_pid:123,prompt_id:'p',event:'stop_failure',error:'authentication_failed',received_at:Date.now()},
      {identity,sessionGroup:'origin'});
    process.send({notice:store.read('origin').pending_notice,noticeScope});
  }
  if(message==='second') {
    try{await startSupervisor(options);process.send({duplicateUnexpected:true});}
    catch(error){process.send({duplicateError:error.code ?? error.message,originalListening:service.server.listening});}
  }
});
