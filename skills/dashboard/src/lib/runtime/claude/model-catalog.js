function models() {
  return [
    { id: 'fable[1m]', display_name: 'Fable [1M] (latest)' },
    { id: 'opus', display_name: 'Opus (latest)' },
    { id: 'opus[1m]', display_name: 'Opus [1M] (latest)' },
    { id: 'sonnet', display_name: 'Sonnet (latest)' },
    { id: 'sonnet[1m]', display_name: 'Sonnet [1M] (latest)' },
    { id: 'haiku', display_name: 'Haiku (latest)' },
    { id: 'claude-fable-5-1[1m]' },
    { id: 'claude-fable-5[1m]' },
    { id: 'claude-opus-5-5' },
    { id: 'claude-opus-5-5[1m]' },
    { id: 'claude-opus-5' },
    { id: 'claude-opus-5[1m]' },
    { id: 'claude-sonnet-5' },
    { id: 'claude-opus-4-8' },
    { id: 'claude-opus-4-8[1m]' },
    { id: 'claude-opus-4-7' },
    { id: 'claude-opus-4-7[1m]' },
    { id: 'claude-opus-4-6' },
    { id: 'claude-opus-4-6[1m]' },
    { id: 'claude-sonnet-4-6' },
    { id: 'claude-haiku-4-5-20251001' },
  ];
}

function effortsFor(model) {
  if (/^(fable|claude-fable-|opus|claude-opus-5|claude-opus-4-[89]|claude-opus-4-[1-9]\d|claude-sonnet-5)/.test(model)) {
    return ['low', 'medium', 'high', 'xhigh'];
  }
  if (/^(haiku|claude-haiku-)/.test(model)) {
    return [];
  }
  return ['low', 'medium', 'high'];
}

export default Object.freeze({
  models,
  effortsFor,
  defaultEfforts: Object.freeze(['low', 'medium', 'high']),
  strict: false,
});
