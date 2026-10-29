import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OBSERVER_SIZE, OBSERVER_SIZE_LIMITS, validObserverSize } from '../../public/js/observer-size.js';

const XTERM_JS_SHA256 = 'dcad74eddc249c9be1ff62ba66b58584418ce1a10727d1879461adc1311c9780';
const XTERM_CSS_SHA256 = 'a396d0aa1f91733337c046445e1a610e93a5ca6b2ce37353dca07bcf48091691';
const SYMBOLS_SHA256 = '3f4cbf93d2ca9cd89cd21ab3de53caf90f4a4fb72f00d2c49819f75167a49b26';
const assetRoot = path.resolve(new URL('../../assets/observer', import.meta.url).pathname);
let cachedFrame = null;

function readPinnedAsset(name, expectedSha256, encoding = 'utf8') {
  const value = fs.readFileSync(path.join(assetRoot, name));
  const actual = crypto.createHash('sha256').update(value).digest('hex');
  if (actual !== expectedSha256) throw new Error(`Observer renderer asset digest mismatch: ${name}`);
  return value.toString(encoding);
}

export function observerFrameDocument() {
  if (cachedFrame) return cachedFrame;
  const xtermJs = readPinnedAsset('xterm.js', XTERM_JS_SHA256).replaceAll('</script', '<\\/script');
  const xtermCss = readPinnedAsset('xterm.css', XTERM_CSS_SHA256);
  const symbols = readPinnedAsset('observer-symbols.woff2', SYMBOLS_SHA256, 'base64');
  cachedFrame = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-observer-frame'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'">
<style>@font-face{font-family:"Zylos Observer Symbols";src:url(data:font/woff2;base64,${symbols}) format("woff2");unicode-range:U+2190-21FF,U+2300-23FF,U+25A0-25FF,U+2700-27BF,U+2605-2606,U+2610-2612,U+26A0-26A1,U+26D4,U+29C9,U+2B24}html,body,#terminal{box-sizing:border-box;width:100%;height:100%;margin:0;background:#0a0f14}${xtermCss}</style>
</head><body><div id="terminal"></div>
<script nonce="observer-frame">${xtermJs}</script>
<script nonce="observer-frame">
const OBSERVER_SIZE_LIMITS=${JSON.stringify(OBSERVER_SIZE_LIMITS)};
const validObserverSize=${validObserverSize.toString()};
const fallbackFamily='ui-monospace,"SF Mono",Menlo,"Cascadia Mono",Consolas,"DejaVu Sans Mono","Liberation Mono","Noto Sans Mono",monospace';
const fontFamily='"Zylos Observer Symbols",'+fallbackFamily;
const terminal=new Terminal({...${JSON.stringify(DEFAULT_OBSERVER_SIZE)},fontFamily,fontSize:15,disableStdin:true,cursorBlink:false,convertEol:false,theme:{background:'#0a0f14'}});
let channel=null,opened=false,stopped=false,pendingSize=null,metricsFrame=null,fontTimer=null;
function reportMetrics(){
  if(!opened||stopped||!channel||metricsFrame!==null)return;
  metricsFrame=requestAnimationFrame(()=>{
    metricsFrame=null;
    if(stopped||!channel)return;
    const rect=document.querySelector('.xterm-screen')?.getBoundingClientRect();
    if(rect&&Number.isFinite(rect.width)&&Number.isFinite(rect.height)&&rect.width>0&&rect.height>0)
      channel.postMessage({type:'metrics',width:Math.ceil(rect.width),height:Math.ceil(rect.height)});
  });
}
function shutdown(){
  if(stopped)return;
  stopped=true;
  clearTimeout(fontTimer);
  if(metricsFrame!==null)cancelAnimationFrame(metricsFrame);
  removeEventListener('message',initialize);
  terminal.dispose();
  if(channel){channel.onmessage=null;channel.close();channel=null;}
}
function initialize(event){
  if(stopped||event.source!==parent||event.data?.type!=='observer-init'||event.ports.length!==1||channel)return;
  channel=event.ports[0];
  removeEventListener('message',initialize);
  channel.onmessage=({data})=>{
    if(stopped||!data||typeof data!=='object')return;
    if(data.type==='shutdown'){shutdown();return;}
    if(data.type==='size'&&validObserverSize(data)){
      if(opened){terminal.resize(data.cols,data.rows);reportMetrics();}
      else pendingSize={cols:data.cols,rows:data.rows};
    }else if(opened&&data.type==='render'&&data.bytes instanceof ArrayBuffer&&data.bytes.byteLength<=262144)terminal.write(new Uint8Array(data.bytes));
  };
  channel.start();
  if(opened){channel.postMessage({type:'ready'});reportMetrics();}
}
addEventListener('message',initialize);
addEventListener('pagehide',shutdown);
async function openTerminal(){
  const fontLoaded=Promise.resolve().then(()=>document.fonts.load('15px "Zylos Observer Symbols"','⏵')).then(()=>true,()=>false);
  fontLoaded.then((loaded)=>{
    if(!loaded||!opened||stopped)return;
    // Changing the value twice also invalidates xterm's cached character measurements.
    terminal.options.fontFamily=fallbackFamily;
    terminal.options.fontFamily=fontFamily;
    reportMetrics();
  });
  await Promise.race([fontLoaded,new Promise(resolve=>{fontTimer=setTimeout(resolve,1000);})]);
  clearTimeout(fontTimer);
  if(stopped)return;
  terminal.open(document.getElementById('terminal'));
  // Read-only viewing must not summon a mobile keyboard via xterm's helper.
  const textarea=terminal.textarea;
  textarea.readOnly=true;
  textarea.setAttribute('inputmode','none');
  textarea.setAttribute('tabindex','-1');
  textarea.addEventListener('focus',()=>textarea.blur());
  // xterm cancels wheel events on the alternate screen (Claude Code) and whenever mouse
  // reporting is on (Zellij), even when a custom wheel handler declines them. Input is
  // disabled, so stop the wheel before it reaches xterm and let the page scroll instead.
  addEventListener('wheel',event=>event.stopPropagation(),{capture:true,passive:true});
  opened=true;
  terminal.onResize(reportMetrics);
  if(pendingSize)terminal.resize(pendingSize.cols,pendingSize.rows);
  if(channel)channel.postMessage({type:'ready'});
  reportMetrics();
}
openTerminal();
</script></body></html>`;
  return cachedFrame;
}

export const OBSERVER_FRAME_ASSETS = Object.freeze({
  xtermJsSha256: XTERM_JS_SHA256,
  xtermCssSha256: XTERM_CSS_SHA256,
  symbolsSha256: SYMBOLS_SHA256,
});
