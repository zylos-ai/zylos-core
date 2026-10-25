import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { loadCoreModule } from './core-modules.js';
import { durableJson } from './runtime-generation.js';
import { enqueueMachineControl } from './machine-control.js';
import { UsageMonitor } from './usage-monitor.js';
const { readSessionMode, readZylosConfigOrThrow } = await loadCoreModule('config.js');
const { readSessionState, readRuntimeHealth, readAccountUsage } = await loadCoreModule('session-state-reader.js');
const { zylosRoot } = await loadCoreModule('session-group-paths.js');
const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
const enabled = (value, fallback) => value === undefined ? fallback : value === true || value === 'true';
function runScript(script, timeoutMs) {
  return new Promise((resolve,reject)=>execFile(process.execPath,[script],{encoding:'utf8',timeout:timeoutMs,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
}
const healthPrompt = 'System health check. Use the health-check skill sanitized helper for PM2 services; never run or print raw pm2 jlist output. Check disk space (df -h) and memory (free -m). If any issues found, use your judgment to notify whoever is most likely to help — check your memory for a designated owner or ops person, otherwise pick the person you normally work with. Log results to ~/zylos/logs/health.log.';

/** Machine maintenance never owns lifecycle state and never blocks the loop on a child. */
export class SupervisorMachineTasks {
  constructor({zylosDir=zylosRoot(),readMode=readSessionMode,readConfig=readZylosConfigOrThrow,
    readOriginState,readHealth=readRuntimeHealth,readUsage=readAccountUsage,now=Date.now,
    enqueue=enqueueMachineControl,execute=runScript,log=()=>{}}={}) {
    Object.assign(this,{zylosDir,readMode,readConfig,readHealth,readUsage,now,enqueue,execute,log});
    this.readOriginState=readOriginState ?? (async()=>{
      const group=(await this.readMode()).mode==='multi'?'origin':null;
      const scene=await readSessionState(group,{freshnessMs:30000});
      return {...scene.identity,...(scene.status.valid?scene.status.value:{}),sampleValid:scene.status.valid};
    });
    this.pending=new Map();this.monitors=new Map();this.stopped=false;
  }
  state(name) {try{return JSON.parse(fs.readFileSync(path.join(this.zylosDir,'activity-monitor',name+'.json'),'utf8'));}catch{return null;}}
  write(name,value) {durableJson(path.join(this.zylosDir,'activity-monitor',name+'.json'),value);}
  schedule(key,operation) {
    if(this.stopped||this.pending.has(key))return false;
    const promise=Promise.resolve().then(operation).catch(error=>this.log(`${key}: ${error.code??error.message}`)).finally(()=>{if(this.pending.get(key)===promise)this.pending.delete(key);});
    this.pending.set(key,promise);return true;
  }
  async control(content,priority=3) {
    const result=await this.enqueue(['enqueue','--content',content,'--priority',String(priority),'--no-ack-suffix'],{readMode:this.readMode});
    if(!result.ok)throw new Error(result.output);return result;
  }
  daily(id,hour,parts,operation) {
    if(parts.hour!==hour||this.state(id)?.last_date===parts.date)return;
    this.schedule(id,async()=>{if(await operation()===false)return;this.write(id,{last_date:parts.date,updated_at:new Date(this.now()).toISOString()});});
  }
  monitor(runtime,config,hour) {
    let monitor=this.monitors.get(runtime);
    const opts={zylosDir:this.zylosDir,usageStateFile:path.join(this.zylosDir,'activity-monitor','usage.json'),
      usageCodexStateFile:path.join(this.zylosDir,'activity-monitor','usage-codex.json'),
      usageAlertStateFile:path.join(this.zylosDir,'activity-monitor',runtime==='claude'?'usage-alert-state.json':'usage-codex-alert-state.json'),
      monitorEnabled:enabled(config.usage_monitor_enabled,true),alertEnabled:enabled(config.usage_alert_enabled,false),
      checkIntervalSec:number(config.usage_check_interval,3600),idleGateSec:number(config.usage_idle_gate,30),
      warnThreshold:number(config.usage_warn_threshold,80),highThreshold:number(config.usage_high_threshold,90),criticalThreshold:number(config.usage_critical_threshold,95),
      notifyCooldownSec:number(config.usage_notify_cooldown,14400),activeHoursStart:number(config.usage_active_hours_start,8),activeHoursEnd:number(config.usage_active_hours_end,23),
      getLocalHour:()=>hour,readMode:this.readMode,readAccountUsage:this.readUsage,log:this.log,
      enqueueMachineControl:this.enqueue};
    if(!monitor){monitor=new UsageMonitor({runtimeId:runtime},opts);monitor.lastUsageCheckAt=monitor.initializeLastCheckAt(Math.floor(this.now()/1000));this.monitors.set(runtime,monitor);}
    else monitor.options=opts;
    return monitor;
  }
  async tick() {
    if(this.stopped)return;
    const config=await this.readConfig();const now=this.now(),seconds=Math.floor(now/1000);
    const date=new Date(now),parts={hour:date.getHours(),date:`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`};
    this.daily('daily-memory-commit-state',3,parts,()=>this.execute(fileURLToPath(new URL('../../zylos-memory/scripts/daily-commit.js',import.meta.url)),30000));
    const dailyDue=(id,hour)=>parts.hour===hour && this.state(id)?.last_date!==parts.date && !this.pending.has(id);
    const upgradeDue=dailyDue('upgrade-check-state',6);
    const dailyUpgradeDue=enabled(config.daily_upgrade_enabled,false) && dailyDue('daily-upgrade-state',5);
    const healthDue=enabled(config.health_check_enabled,true) && !this.pending.has('health-check') && seconds-(this.state('health-check-state')?.last_check_at??0)>=86400;
    const usageDue=['claude','codex'].flatMap(runtime=>{
      const monitor=this.monitor(runtime,config,parts.hour);
      if(this.pending.has(`usage:${runtime}`))return [];
      const sample=monitor.isMonitorEnabled() && seconds-monitor.getLastMonitorRunAt()>=monitor.options.checkIntervalSec;
      const alert=monitor.isAlertEnabled() && seconds-monitor.getLastAlertRunAt()>=number(config.usage_alert_interval,3600);
      return sample||alert?[{runtime,monitor,sample,alert}]:[];
    });
    if(!upgradeDue && !dailyUpgradeDue && !healthDue && !usageDue.length)return;
    const origin=await this.readOriginState();
    const health=origin.runtime&&origin.runtime!=='unknown'?await this.readHealth(origin.runtime):null;
    const healthy=health && !health.unreadable && (health.missing||health.health==='ok');
    if(healthy) {
      if(upgradeDue)this.daily('upgrade-check-state',6,parts,()=>this.execute(fileURLToPath(new URL('./upgrade-check.js',import.meta.url)),300000));
      if(dailyUpgradeDue&&origin.runtime==='claude')this.daily('daily-upgrade-state',5,parts,()=>this.control('Daily upgrade. Use the upgrade-claude skill to upgrade Claude Code to the latest version.'));
      if(healthDue&&origin.present) {
        this.schedule('health-check',async()=>{await this.control(healthPrompt);this.write('health-check-state',{last_check_at:seconds,last_check_human:date.toISOString().replace('T',' ').slice(0,19)});});
      }
    }
    for(const {runtime,monitor,sample,alert} of usageDue) {
      const account=await this.readHealth(runtime);if(account.unreadable||(!account.missing&&account.health!=='ok'))continue;
      const idleSince=origin.idleSince??origin.idle_since;
      const snapshot={currentTime:seconds,claudeState:origin.sampleValid===false?'unknown':origin.state,
        idleSeconds:Number.isFinite(idleSince)?Math.max(0,(now-idleSince)/1000):0};
      if(!monitor.canRunTask(snapshot))continue;
      if(sample) {
        this.schedule(`usage:${runtime}`,()=>monitor.runMonitor({currentTime:seconds}));
      }else if(alert &&monitor.canRunTask({...snapshot,activeHoursOnly:true}))this.schedule(`usage:${runtime}`,()=>monitor.runAlert({currentTime:seconds}));
    }
  }
  async stop(){this.stopped=true;await Promise.allSettled([...this.pending.values()]);}
}
