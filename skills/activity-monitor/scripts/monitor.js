#!/usr/bin/env node
/** M4 observes and reconciles sessions; M1 exclusively owns process launch. */
import { pathToFileURL } from 'node:url';
import { startSupervisor } from './supervisor-main.js';

export async function main({start=startSupervisor,runtime=process,log=console.error}={}) {
  const service=await start();
  for(const signal of ['SIGTERM','SIGINT'])runtime.once(signal,()=>{
    void service.stop().then(()=>runtime.exit(0),error=>{log(error.code ?? error.message);runtime.exit(1);});
  });
  return service;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await main();
