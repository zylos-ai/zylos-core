import { SupervisorAdmission } from '../../supervisor-admission.js';
const variant=process.argv[5];process.argv[5]='';
if(variant==='ignore-admission-session'){
 const manual=SupervisorAdmission.prototype.manual;
 SupervisorAdmission.prototype.manual=function(request,rows){const copy={...request};delete copy.expectedSessionId;return manual.call(this,copy,rows);};
}
await import('./supervisor-manual-entry-worker.js');
