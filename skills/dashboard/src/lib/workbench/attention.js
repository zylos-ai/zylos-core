import fs from 'node:fs';
import path from 'node:path';

export const CHANNEL_RESTART_WINDOW_MS = 10 * 60_000;

export async function installedChannels(zylosDir, loadCoreModule) {
  const { parseSkillMd } = await loadCoreModule('skill.js');
  const skillsDir = path.join(zylosDir, '.claude', 'skills');
  return fs.readdirSync(skillsDir).flatMap(channel => {
    const metadata = parseSkillMd(path.join(skillsDir, channel))?.frontmatter;
    const service = metadata?.lifecycle?.service?.name;
    return metadata?.type === 'communication' && typeof service === 'string' && service
      ? [{ channel, service }] : [];
  });
}

export function createChannelRestartCounter() {
  const samples = new Map();
  return {
    update(data) {
      const at = data.collectedAt;
      if (!Number.isFinite(at)) return;
      const present = new Set(data.processes.map(process => process.name));
      for (const name of samples.keys()) if (!present.has(name)) samples.delete(name);
      for (const process of data.processes) {
        const count = process.pm2_env?.restart_time;
        if (!Number.isSafeInteger(count) || count < 0) continue;
        const previous = samples.get(process.name);
        if (previous && at <= previous.at) continue;
        const events = previous?.events.filter(event => event.at > at - CHANNEL_RESTART_WINDOW_MS) ?? [];
        if (previous && count > previous.count) events.push({ at, count: count - previous.count });
        samples.set(process.name, { at, count, events });
      }
    },
    get(service, at = Date.now()) {
      return (samples.get(service)?.events ?? []).reduce((sum, event) =>
        sum + (event.at > at - CHANNEL_RESTART_WINDOW_MS && event.at <= at ? event.count : 0), 0);
    },
  };
}
