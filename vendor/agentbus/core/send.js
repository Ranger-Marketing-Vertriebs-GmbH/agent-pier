import { listPeers, resolvePeer } from './peers.js';
import { createMessage } from './message.js';
import { enqueue, pendingSummary } from './inbox.js';
import { nudge, nudgeText } from './nudge.js';

export async function send(h, { self, to, text, replyTo }, deps = {}) {
  const { ps, nudgeFn = nudge, now = Date.now } = deps;
  const target = resolvePeer((deps.listPeers || listPeers)(h, ps), to);
  if (!target.alive) {
    const e = new Error(`agentbus: Peer "${to}" lebt nicht mehr`);
    e.code = 'DEAD_PEER'; throw e;
  }
  if (target.key === self.key) {
    const e = new Error('agentbus: Nachricht an sich selbst');
    e.code = 'SELF_SEND'; throw e;
  }
  const msg = createMessage({ from: self, to: target.key, toName: target.name, text, replyTo }, now());
  enqueue(h, target.key, msg);
  const n = pendingSummary(h, target.key).count;
  let nudged=false;
  try { nudged = n > 0 && await nudgeFn(target, nudgeText(n, self.name, target.runtime, msg.id), self.name, deps); } catch { /* Enqueue succeeded; a failed wake must not invite a duplicate resend. */ }
  return { id: msg.id, to: target.key, toName: target.name, nudged };
}
