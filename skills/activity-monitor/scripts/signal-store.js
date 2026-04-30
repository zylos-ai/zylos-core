import fs from 'node:fs';

export function consumeRecentUserMessageSignal({
  signalFile,
  currentTime,
  ttlSec = 60
}) {
  try {
    if (!fs.existsSync(signalFile)) {
      return { consumed: false, fresh: false, signal: null };
    }

    const signal = JSON.parse(fs.readFileSync(signalFile, 'utf8'));
    fs.unlinkSync(signalFile);

    const timestamp = Number(signal?.timestamp) || 0;
    const fresh = timestamp > 0 && (currentTime - timestamp) < ttlSec;
    return { consumed: true, fresh, signal };
  } catch {
    return { consumed: false, fresh: false, signal: null };
  }
}
