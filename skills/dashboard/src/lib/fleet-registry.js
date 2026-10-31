function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function validateFleetRegistry(input) {
  const errors = [];
  const source = input == null ? [] : input;

  if (!Array.isArray(source)) {
    return { agents: [], errors: ['fleet.agents must be an array'] };
  }

  const agents = [];
  const seenNames = new Set();

  source.forEach((entry, index) => {
    const prefix = `fleet.agents[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }

    const errorCountBeforeEntry = errors.length;
    const name = asTrimmedString(entry.name);
    const nameKey = name.toLowerCase();
    const baseUrl = normalizeBaseUrl(entry.base_url);
    const readApiKey = asTrimmedString(entry.read_api_key);

    if (!name) {
      errors.push(`${prefix}.name must be a non-empty string`);
    } else if (seenNames.has(nameKey)) {
      errors.push(`${prefix}.name must be unique`);
    } else {
      seenNames.add(nameKey);
    }

    if (!baseUrl) {
      errors.push(`${prefix}.base_url must be a valid http(s) URL`);
    }

    if (!readApiKey) {
      errors.push(`${prefix}.read_api_key must be a non-empty string`);
    }

    if (errors.length === errorCountBeforeEntry) {
      agents.push({ name, base_url: baseUrl, read_api_key: readApiKey });
    }
  });

  return { agents: errors.length > 0 ? [] : agents, errors };
}

export function loadFleetRegistry(config = {}) {
  return validateFleetRegistry(config.fleet?.agents);
}
