import { SupervisorAdmission } from '../../supervisor-admission.js';
import { SupervisorScenes } from '../../supervisor-scenes.js';
const variant=process.argv[5];process.argv[5]='';
if(variant==='ignore-admission-session'){
 const manual=SupervisorAdmission.prototype.manual;
 SupervisorAdmission.prototype.manual=function(request,rows){const copy={...request};delete copy.expectedSessionId;return manual.call(this,copy,rows);};
}
if(variant==='ignore-execution-session'){
 const verify=SupervisorScenes.prototype.verifyFixed;
 SupervisorScenes.prototype.verifyFixed=async function(...args){const read=this.readReady;this.readReady=async()=>null;try{return await verify.apply(this,args);}finally{this.readReady=read;}};
}
await import('./supervisor-manual-entry-worker.js');
