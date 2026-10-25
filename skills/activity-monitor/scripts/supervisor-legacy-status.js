import fs from 'node:fs';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
import { SessionActivity } from './session-activity.js';
import { durableJson } from './runtime-generation.js';
import { publicHealth } from './status-writer.js';
const { legacyRunDir, zylosRoot } = await loadCoreModule('session-group-paths.js');
const { openTmuxConnection } = await loadCoreModule('runtime/tmux-connection.js');
const { observeSessionTarget, revalidateSessionTarget, readProcessTree } = await loadCoreModule('runtime/session-target.js');
const sameForeground=(a,b)=>a && b && ['session_id','claude_pid','runtime','observed_at'].every(key=>a[key]===b[key]);

/** Migration-only legacy state projection. This observer never enters pool
 * inventory, emits crash decisions, changes fences, or terminates a process. */
export class SupervisorLegacyStatus {
  constructor({env=process.env,connectionOptions={},now=Date.now,readHealth,log=()=>{},
    open=openTmuxConnection,observeTarget=observeSessionTarget,readTree=readProcessTree}={}) {
    Object.assign(this,{env,connectionOptions,now,readHealth,log,open,observeTarget,readTree});
    this.directory=legacyRunDir(env);this.activity=null;this.key=null;
  }
  foreground() {
    try {
      const value=JSON.parse(fs.readFileSync(path.join(this.directory,'foreground-session.json'),'utf8'));
      return value?.version===1 && ['claude','codex'].includes(value.runtime) && typeof value.session_id==='string' &&
        /^[A-Za-z0-9_-]+$/.test(value.session_id) && Number.isSafeInteger(value.claude_pid) && value.claude_pid>1 &&
        Number.isSafeInteger(value.observed_at) && value.observed_at>=0 ? value : null;
    } catch{return null;}
  }
  close(){this.activity?.close();this.activity=null;this.key=null;}
  async tick() {
    const foreground=this.foreground();if(!foreground){this.close();return;}
    let connection;
    try {
      connection=await this.open(this.connectionOptions);
      let tree;const getTree=async()=>tree ??= await this.readTree();
      const target=await this.observeTarget({sessionGroup:null,tmuxName:`${foreground.runtime}-main`,connection,
        readReady:async()=>null,readProcessTree:getTree});
      if(!target.present){this.close();return;}
      if(target.runId || target.runtime!==foreground.runtime || foreground.observed_at<target.createdAt*1000)return;
      const panePid=Number((await connection.command(['display-message','-p','-t',target.paneId,'#{pane_pid}'])).trim());
      const rows=await getTree(), process=rows.find(row=>row.pid===foreground.claude_pid);
      if(process?.name.replace(/\.exe$/,'')!==foreground.runtime)return;
      let cursor=process,owned=false;const visited=new Set();
      while(cursor && !visited.has(cursor.pid)) {
        if(cursor.pid===panePid){owned=true;break;}
        visited.add(cursor.pid);cursor=rows.find(row=>row.pid===cursor.ppid);
      }
      if(!owned)return;
      const key=[target.serverGeneration,target.tmuxSessionId,target.paneId,foreground.claude_pid,foreground.session_id,foreground.observed_at].join(':');
      if(key!==this.key) {
        this.close();this.key=key;
        this.activity=new SessionActivity({runDir:this.directory,runId:null,sessionId:foreground.session_id,
          runtime:foreground.runtime,startedAt:foreground.observed_at,warn:this.log});
        // Before migration, Claude's own file is already named by its foreground
        // session id; never select the newest file in this project directory.
        if(foreground.runtime==='claude')this.activity.transcriptPath=path.join(this.env.HOME,'.claude','projects',
          zylosRoot(this.env).replace(/\//g,'-'),`${foreground.session_id}.jsonl`);
      }
      const now=this.now(),activity=this.activity.read(now),health=await this.readHealth(foreground.runtime);
      await revalidateSessionTarget({connection,target});
      if(!sameForeground(foreground,this.foreground()))return;
      const payload={runId:null,sessionId:foreground.session_id,runtime:foreground.runtime,
        state:!activity.transcriptMtimeMs && !activity.events.length && !activity.tools.length?'unknown':activity.state,
        health:publicHealth(health.health),idle_seconds:Math.max(0,Math.floor((now-activity.lastActivityAt)/1000)),
        last_activity:activity.lastActivityAt,active_tools:activity.tools.length,last_api_activity:activity.lastActivityAt,
        active_tool_details:activity.tools,proc:{pid:foreground.claude_pid,alive:true,frozen:null,last_sample_at:now},updated_at:now};
      if(health.health!=='ok' && health.reason)payload.unavailable_reason=health.reason;
      durableJson(path.join(this.directory,'agent-status.json'),payload);
      return payload;
    } catch(error) {
      if(['TMUX_NO_SERVER','TARGET_GONE','GENERATION_CHANGED'].includes(error.code)){this.close();return;}
      throw error;
    } finally {connection?.close();}
  }
}
