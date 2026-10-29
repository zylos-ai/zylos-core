import path from 'node:path';

export function observerPaths(dataDir) {
  const root = path.join(dataDir, 'observer');
  return {
    root,
    artifacts: path.join(root, 'artifacts'),
    staging: path.join(root, 'staging'),
    runtime: path.join(root, 'runtime'),
    config: path.join(root, 'runtime', 'config'),
    cache: path.join(root, 'runtime', 'cache'),
    data: path.join(root, 'runtime', 'data'),
    logs: path.join(root, 'runtime', 'tmp'),
    control: path.join(root, 'runtime', 'control'),
    installedManifest: path.join(root, 'installed.json'),
  };
}
