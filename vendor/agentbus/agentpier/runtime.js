import path from 'node:path';
import {readJson,writeJsonAtomic,listFiles} from '../core/fsx.js';
import {peerKey,peersDir} from '../core/paths.js';
import {listPeers,register} from '../core/peers.js';
import {pidStart} from '../core/proc.js';
import {claudeRegistryEntry,sanitizeName,findRuntimePid} from '../hooks/register.js';
import {nudge} from '../core/nudge.js';
import {makeTools} from '../mcp/tools.js';

const idPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export function loadLaunch(h,id){
 if(!idPattern.test(id||''))throw new Error('AgentBus: invalid launch identity');
 const item=readJson(path.join(h,'launches',`${id}.json`));
 if(item.id!==id||!['codex','claude','opencode'].includes(item.tool)||!path.isAbsolute(item.cwd)||path.basename(h)!==item.projectId)throw new Error('AgentBus: invalid launch record');
 return item;
}
export function context(env=process.env){const h=env.AGENTBUS_HOME;if(!h||!path.isAbsolute(h))throw new Error('AgentBus: missing project scope');return {h,launch:loadLaunch(h,env.AGENTPIER_AGENTBUS_SESSION),env};}
export function trustedPeers(h,ps){
 return listPeers(h,ps).filter(peer=>{
  try{const launch=loadLaunch(h,peer.agentpierSessionId);return peer.runtime===launch.tool&&peer.cwd===launch.cwd&&peer.key===peerKey(peer.runtime,peer.sessionId)&&(peer.sessionId===launch.id||peer.runtime==='opencode'&&peer.sessionId===`${launch.id}--${peer.nativeSessionId}`);}catch{return false;}
 });
}
export function trustedIdentities(h){
 const result=[];
 for(const name of listFiles(path.join(h,'identities'))){
  if(!name.endsWith('.json'))continue;
  try{
   const peer=readJson(path.join(h,'identities',name));const launch=loadLaunch(h,peer.agentpierSessionId);
   if(peer.runtime===launch.tool&&peer.cwd===launch.cwd&&peer.key===peerKey(peer.runtime,peer.sessionId)&&name===`${peer.key}.json`&&(peer.sessionId===launch.id||peer.runtime==='opencode'&&peer.sessionId===`${launch.id}--${peer.nativeSessionId}`))result.push(peer);
  }catch{}
 }
 return result;
}
export function registerPeer(ctx,nativeSessionId,{pid,ps=pidStart}={}){
 if(typeof nativeSessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(nativeSessionId))throw new Error('AgentBus: missing exact native session identity');
 const {launch,h}=ctx;
 if(!pid){if(launch.tool==='opencode')pid=process.pid;else{try{pid=findRuntimePid(launch.tool);}catch{pid=process.ppid;}}}
 const start=ps(pid);if(!start)throw new Error('AgentBus: runtime process has ended');
 const bound=trustedPeers(h,ps).find(peer=>peer.agentpierSessionId===launch.id&&peer.alive);
 if(bound&&bound.pid!==pid)throw new Error('AgentBus: nested runtime cannot replace the launched session');
 const sessionId=launch.tool==='opencode'?`${launch.id}--${nativeSessionId}`:launch.id;
 const peer={runtime:launch.tool,sessionId,nativeSessionId,agentpierSessionId:launch.id,pid,pidStart:start,cwd:launch.cwd,name:sanitizeName(`${path.basename(launch.cwd)}-${launch.id.slice(-6)}${launch.tool==='opencode'?`-${nativeSessionId.slice(-4)}`:''}`),nudge:{kind:'none'}};
 const key=peerKey(peer.runtime,sessionId);
 writeJsonAtomic(path.join(h,'identities',`${key}.json`),{key,runtime:peer.runtime,sessionId,nativeSessionId,agentpierSessionId:launch.id,cwd:launch.cwd,name:peer.name});
 register(h,peer);return {...peer,key};
}
export function self(ctx,nativeSessionId){
 if(ctx.launch.tool==='opencode'&&(typeof nativeSessionId!=='string'||!nativeSessionId))throw new Error('AgentBus: exact OpenCode session context is required');
 const peers=trustedPeers(ctx.h).filter(peer=>peer.agentpierSessionId===ctx.launch.id&&peer.alive);
 const hits=ctx.launch.tool==='opencode'?peers.filter(peer=>peer.nativeSessionId===nativeSessionId):peers;
 if(hits.length!==1)throw new Error('AgentBus: native session not registered; review the session hooks if required');
 return hits[0];
}
export async function trustedNudge(h,peer,text,from,deps={}){
 const current=trustedPeers(h,deps.ps).find(item=>item.key===peer.key&&item.alive);if(!current)return false;
 const launch=loadLaunch(h,current.agentpierSessionId);let target={...current,nudge:{kind:'none'}};
 if(current.runtime==='codex')target.nudge={kind:'codex-queue',threadId:current.nativeSessionId,command:launch.command,codexHome:launch.codexHome};
 if(current.runtime==='claude')try{const entry=claudeRegistryEntry(current.nativeSessionId,launch.claudeSessionsDir,{ps:deps.ps||pidStart});if(entry.pid===current.pid)target.nudge={kind:'cc-socks',socketPath:entry.messagingSocketPath,keyPath:entry.keyPath,pid:entry.pid};}catch{return false;}
 if(current.runtime==='opencode'&&current.socketPath){
  // The pathname is derived from this project and process, never from peer input.
  const socketRoot=`/tmp/ap-bus-${process.getuid?.()||0}-${(await import('node:crypto')).createHash('sha256').update(h).digest('hex').slice(0,12)}`;
  target.nudge={kind:'oc-sock',socketPath:path.join(socketRoot,`${current.pid}.sock`),sessionId:current.nativeSessionId};
 }
 return nudge(target,text,from,deps);
}
export function toolsFor(ctx,deps={}){
 return makeTools(ctx.h,args=>self(ctx,args?.__agentpierSession),{...deps,listPeers:(h)=>trustedPeers(h,deps.ps),nudgeFn:(peer,text,from)=>trustedNudge(ctx.h,peer,text,from,deps)}).map(tool=>({...tool,inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,...(ctx.launch.tool==='opencode'?{__agentpierSession:{type:'string',description:'Native OpenCode session context, supplied by the AgentPier adapter.'}}:{})}}}));
}
