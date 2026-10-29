import { stateMood } from './agent-fleet.js';

const STORAGE_KEY = 'fleet-sounds-muted';
const WORKING_MOODS = new Set(['busy', 'thinking']);

// Line-style bell icons (Feather, MIT) — stroke follows the button's
// currentColor so CSS owns the on/off tinting.
const BELL_ON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
const BELL_OFF_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/>' +
  '<path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/>' +
  '<line x1="1" y1="1" x2="23" y2="23"/></svg>';

export function isWorkingMood(mood) {
  return WORKING_MOODS.has(mood);
}

// Diffs the previous per-agent mood map against a fresh fleet payload.
// Agents seen for the first time seed the map silently, so a page load (or an
// agent joining the fleet) never fires a burst of cues. busy<->thinking is not
// a transition, and working->stuck/offline deliberately skips the finish cue —
// that state gets surfaced visually, a "done" chime would be misleading.
export function computeFleetTransitions(prevMoods, agents) {
  const moods = new Map();
  const started = [];
  const finished = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    const name = String(agent?.name || '');
    if (!name) continue;
    const mood = stateMood(agent);
    moods.set(name, mood);
    const prev = prevMoods instanceof Map ? prevMoods.get(name) : undefined;
    if (prev === undefined) continue;
    if (!isWorkingMood(prev) && isWorkingMood(mood)) started.push(name);
    else if (isWorkingMood(prev) && mood === 'idle') finished.push(name);
  }
  return { moods, started, finished };
}

function loadMuted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Default muted: the wall should never make noise unprompted.
    return raw == null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function createFleetSounds({ button, labels, mediaDevices, doc } = {}) {
  let muted = loadMuted();
  let prevMoods = new Map();
  let audioCtx = null;
  const devices = mediaDevices !== undefined
    ? mediaDevices
    : (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
  const docRef = doc !== undefined ? doc : (typeof document !== 'undefined' ? document : undefined);

  function ensureContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      // Chrome binds a context's output to the device that was default at
      // creation and won't follow later changes on its own. Pinning the sink
      // to '' (the UA default) makes the routing explicit where supported
      // (Chrome 110+); rebinding on device changes is handled below.
      if (typeof audioCtx.setSinkId === 'function') {
        audioCtx.setSinkId('').catch(() => {});
      }
    }
    return audioCtx;
  }

  // Closing the context kills everything scheduled into it — pending
  // resume() callbacks see a closed (never 'running') context and bail.
  function dropContext() {
    if (!audioCtx) return;
    const old = audioCtx;
    audioCtx = null;
    old.close?.().catch?.(() => {});
  }

  // Re-setting an identical sinkId is a spec'd no-op, so the only reliable way
  // to rebind after the system default output changes (devicechange fires for
  // that — the UA's virtual default device entry updates) is to drop the
  // context and build a fresh one, which binds to the new default at creation.
  function handleDeviceChange() {
    if (!audioCtx) return;
    dropContext();
    if (!muted) ensureContext();
  }

  // Browsers keep a fresh AudioContext suspended until a user gesture. The
  // bell click unlocks it, but on pages without the unmute interaction (a
  // reload with the preference already on, a remote agent detail page) cues
  // would stay queued and expire. Any click on the page is a qualifying
  // gesture — use it to resume.
  function handlePointerDown() {
    if (muted) return;
    const ctx = ensureContext();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  devices?.addEventListener?.('devicechange', handleDeviceChange);
  docRef?.addEventListener?.('pointerdown', handlePointerDown);

  // Browsers create AudioContext suspended until a user gesture, and resume()
  // is async — a synchronous state check here would drop the unmute
  // confirmation and the first cue after it. Play immediately when running,
  // otherwise after resume() settles; skip cues that sat queued past 2s
  // (resume can hang until a qualifying gesture, and a "started" blip
  // arriving minutes late is just noise).
  function playWhenRunning(fn) {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'running') { fn(ctx); return; }
    const requestedAt = Date.now();
    ctx.resume().then(() => {
      if (ctx.state === 'running' && Date.now() - requestedAt < 2000) fn(ctx);
    }).catch(() => {});
  }

  // Marimba-style strike: fixed pitch (no glide), near-instant attack into an
  // exponential decay, plus a quiet 4th-harmonic partial that fades faster
  // than the fundamental — the sparkle that reads as "wooden bar" instead of
  // "synth blip". Timbre and note timings were ear-picked by Howard from the
  // #218 audition page (scheme 2, see issue #223).
  function strike(ctx, { freq, at, decay = 0.28, peak = 0.34 }) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + decay + 0.05);
    const partial = ctx.createOscillator();
    const partialGain = ctx.createGain();
    partial.type = 'sine';
    partial.frequency.setValueAtTime(freq * 4, at);
    partialGain.gain.setValueAtTime(0.0001, at);
    partialGain.gain.exponentialRampToValueAtTime(peak * 0.25, at + 0.004);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, at + decay * 0.6);
    partial.connect(partialGain).connect(ctx.destination);
    partial.start(at);
    partial.stop(at + decay);
  }

  // Cues scheduled at exactly currentTime start mid-render-quantum, so a
  // random slice of the 20ms attack ramp gets clamped away — consecutive
  // plays come out at audibly different loudness. A fixed lead also gives
  // sleepy output paths (Bluetooth/USB speakers reopening their stream)
  // time to wake before the audible part begins. 80ms is below the
  // threshold where a cue would feel detached from the event.
  const SCHEDULE_LEAD = 0.08;

  // Start: two rising strikes (E5 -> A5). Finish: three falling strikes
  // (A5 -> E5 -> B4) with a longer last decay so the phrase settles. Distinct
  // shapes so they're tellable apart without looking at the wall.
  function playStart() {
    playWhenRunning((ctx) => {
      const at = ctx.currentTime + SCHEDULE_LEAD;
      strike(ctx, { freq: 659, at });
      strike(ctx, { freq: 880, at: at + 0.13 });
    });
  }

  function playFinish() {
    playWhenRunning((ctx) => {
      const at = ctx.currentTime + SCHEDULE_LEAD;
      strike(ctx, { freq: 880, at });
      strike(ctx, { freq: 659, at: at + 0.12 });
      strike(ctx, { freq: 494, at: at + 0.24, decay: 0.4 });
    });
  }

  function renderButton() {
    if (!button) return;
    const l = typeof labels === 'function' ? labels() : labels;
    const label = muted ? (l?.soundOff || 'Sounds muted') : (l?.soundOn || 'Sounds on');
    button.innerHTML = muted ? BELL_OFF_ICON : BELL_ON_ICON;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(!muted));
  }

  function toggle() {
    muted = !muted;
    try { localStorage.setItem(STORAGE_KEY, String(muted)); } catch {}
    if (!muted) {
      // The toggle click is the user gesture that unlocks audio; confirm
      // audibly so "did that work?" never needs a second agent to answer.
      // playWhenRunning handles the suspended->running resume internally.
      playStart();
    } else {
      // Mute must be immediate: cues already scheduled SCHEDULE_LEAD ahead
      // (or parked behind a pending resume()) would otherwise still play
      // after the UI says muted. Dropping the context cancels them all.
      dropContext();
    }
    renderButton();
  }

  function handleFleet(fleet) {
    const { moods, started, finished } = computeFleetTransitions(prevMoods, fleet?.agents);
    prevMoods = moods;
    if (muted) return;
    if (started.length > 0) playStart();
    if (finished.length > 0) playFinish();
  }

  if (button) {
    button.addEventListener('click', toggle);
    renderButton();
  }

  return { handleFleet, toggle, isMuted: () => muted, refreshLabels: renderButton };
}
