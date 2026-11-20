import * as store from '../../skills/comm-bridge/scripts/c4-db.js';
import { notifySessionHostAllowlist, notifySessionHostAttached } from '../../skills/comm-bridge/scripts/c4-host-notice.js';

const usage = 'Usage: zylos host attach <group> --to <target> | detach <group> | list | allow <channel> | disallow <channel>';

export async function hostCommand(args) {
  const [command, subject, to, destination] = args;
  const actor = process.env.ZYLOS_SESSION_GROUP ?? 'origin';
  try {
    if (command === 'list' && args.length === 1) {
      console.log(JSON.stringify(store.listSessionHosts(), null, 2));
    } else if (command === 'detach' && args.length === 2) {
      console.log(store.detachSessionHost(subject) ? 'Hosting relationship detached.' : 'No hosting relationship found.');
    } else if (command === 'attach' && args.length === 4 && to === '--to') {
      const attached = store.attachSessionHost(subject, destination, actor);
      console.log(`Hosting active: ${[subject, ...attached.moved].join(', ')} → ${attached.target}`);
      if (attached.notify) await notifySessionHostAttached(attached);
    } else if (['allow', 'disallow'].includes(command) && args.length === 2) {
      const allowed = command === 'allow';
      const changed = store.setSessionHostAllowlist(subject, allowed);
      console.log(changed ? 'Hosting notification allowlist updated.' : 'Hosting notification allowlist already matches.');
      if (changed) await notifySessionHostAllowlist(subject, allowed);
    } else throw new Error(usage);
  } catch (error) {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  }
}
