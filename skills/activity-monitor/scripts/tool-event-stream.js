import fs from 'node:fs';

export function createToolEventStreamState(filePath) {
  return {
    version: 1,
    path: filePath,
    inode: 0,
    offset: 0,
    last_processed_at: 0,
    last_rotation_at: 0,
    rotated_drain: null,
  };
}

function parseJsonlChunk(raw, arrivalSeq, log) {
  const lines = raw.split('\n');
  const tail = raw.endsWith('\n') ? '' : (lines.pop() || '');
  const events = [];
  let nextArrivalSeq = arrivalSeq;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      parsed._arrival_seq = ++nextArrivalSeq;
      events.push(parsed);
    } catch {
      log('Tool event stream: skipped malformed JSONL line');
    }
  }

  return {
    events,
    tail,
    arrivalSeq: nextArrivalSeq,
  };
}

function readJsonlDelta(filePath, offset, tail, arrivalSeq, log) {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      inode: 0,
      size: 0,
      offset: 0,
      tail: '',
      arrivalSeq,
      events: [],
    };
  }

  const stat = fs.statSync(filePath);
  const inode = Number(stat.ino) || 0;
  const normalizedOffset = stat.size < offset ? 0 : offset;

  if (stat.size <= normalizedOffset) {
    return {
      exists: true,
      inode,
      size: stat.size,
      offset: normalizedOffset,
      tail,
      arrivalSeq,
      events: [],
    };
  }

  const length = stat.size - normalizedOffset;
  const fd = fs.openSync(filePath, 'r');
  let chunk = '';
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, normalizedOffset);
    chunk = buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }

  const parsed = parseJsonlChunk(tail + chunk, arrivalSeq, log);
  return {
    exists: true,
    inode,
    size: stat.size,
    offset: stat.size - Buffer.byteLength(parsed.tail, 'utf8'),
    tail: parsed.tail,
    arrivalSeq: parsed.arrivalSeq,
    events: parsed.events,
  };
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort.
  }
}

export function readToolEventsIncrementalFromStream({
  filePath,
  streamState,
  activeTail = '',
  rotatedTail = '',
  arrivalSeq = 0,
  nowMs = Date.now(),
  drainQuietMs = 2000,
  log = () => {},
}) {
  const nextState = streamState
    ? {
      ...streamState,
      rotated_drain: streamState.rotated_drain ? { ...streamState.rotated_drain } : null,
    }
    : createToolEventStreamState(filePath);
  const events = [];
  let nextActiveTail = activeTail;
  let nextRotatedTail = rotatedTail;
  let nextArrivalSeq = arrivalSeq;

  if (nextState.rotated_drain?.path) {
    const drain = nextState.rotated_drain;
    const drainResult = readJsonlDelta(
      drain.path,
      Number(drain.offset) || 0,
      nextRotatedTail,
      nextArrivalSeq,
      log
    );

    if (!drainResult.exists) {
      nextState.rotated_drain = null;
      nextRotatedTail = '';
    } else {
      nextArrivalSeq = drainResult.arrivalSeq;
      nextRotatedTail = drainResult.tail;
      events.push(...drainResult.events);

      drain.inode = Number(drain.inode) || drainResult.inode;
      drain.offset = drainResult.offset;
      const previousSize = Number(drain.last_size) || 0;
      if (drainResult.size > previousSize) {
        drain.last_size = drainResult.size;
        drain.quiet_since = nowMs;
      } else {
        drain.last_size = previousSize || drainResult.size;
        drain.quiet_since = Number(drain.quiet_since) || nowMs;
      }

      const quietForMs = nowMs - (Number(drain.quiet_since) || nowMs);
      if (
        drainResult.offset === drainResult.size &&
        nextRotatedTail === '' &&
        quietForMs >= drainQuietMs
      ) {
        safeUnlink(drain.path);
        nextState.rotated_drain = null;
        nextRotatedTail = '';
      }
    }
  }

  const activeResult = readJsonlDelta(
    filePath,
    Number(nextState.offset) || 0,
    nextActiveTail,
    nextArrivalSeq,
    log
  );

  if (!activeResult.exists) {
    nextState.inode = 0;
    nextState.offset = 0;
    nextActiveTail = '';
    return {
      events,
      streamState: nextState,
      activeTail: nextActiveTail,
      rotatedTail: nextRotatedTail,
      arrivalSeq: nextArrivalSeq,
    };
  }

  if (
    (Number(nextState.inode) && Number(nextState.inode) !== activeResult.inode) ||
    activeResult.size < (Number(nextState.offset) || 0)
  ) {
    const resetResult = readJsonlDelta(filePath, 0, '', nextArrivalSeq, log);
    nextState.inode = resetResult.exists ? resetResult.inode : 0;
    nextState.offset = resetResult.offset;
    nextState.last_processed_at = nowMs;
    nextActiveTail = resetResult.tail;
    nextArrivalSeq = resetResult.arrivalSeq;
    events.push(...resetResult.events);
    return {
      events,
      streamState: nextState,
      activeTail: nextActiveTail,
      rotatedTail: nextRotatedTail,
      arrivalSeq: nextArrivalSeq,
    };
  }

  nextState.inode = activeResult.inode;
  nextState.offset = activeResult.offset;
  nextState.last_processed_at = nowMs;
  nextActiveTail = activeResult.tail;
  nextArrivalSeq = activeResult.arrivalSeq;
  events.push(...activeResult.events);

  return {
    events,
    streamState: nextState,
    activeTail: nextActiveTail,
    rotatedTail: nextRotatedTail,
    arrivalSeq: nextArrivalSeq,
  };
}

export function rotateToolEventStream({
  filePath,
  nowMs = Date.now(),
}) {
  const stat = fs.statSync(filePath);
  const rotatedPath = `${filePath}.old`;

  safeUnlink(rotatedPath);
  fs.renameSync(filePath, rotatedPath);
  fs.writeFileSync(filePath, '');

  return {
    ...createToolEventStreamState(filePath),
    last_rotation_at: nowMs,
    rotated_drain: {
      path: rotatedPath,
      inode: Number(stat.ino) || 0,
      offset: stat.size,
      last_size: stat.size,
      quiet_since: nowMs,
    },
  };
}
