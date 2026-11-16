export function createChannelDownCounter() {
  const counts = new Map();
  return {
    update(data) {
      const statuses = new Map(data.processes.map(process => [process.name, process.pm2_env?.status]));
      for (const name of new Set([...counts.keys(), ...statuses.keys()])) counts.set(name, statuses.get(name) === 'online' ? 0 : (counts.get(name) ?? 0) + 1);
    },
    get(service) { return counts.get(service) ?? 0; },
  };
}
