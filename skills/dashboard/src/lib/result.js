export function ok({ metric, value, source, updatedAt = null, confidence = 'high', capability = 'supported', preferredSource = source, fallbackReason = null, metadata = {} }) {
  return {
    metric,
    value,
    capability,
    availability: 'ok',
    source,
    preferredSource,
    fallbackReason,
    confidence,
    updatedAt,
    metadata
  };
}

export function unavailable({ metric, source, availability = 'missing', reason = null, capability = 'supported', preferredSource = source, metadata = {} }) {
  return {
    metric,
    value: null,
    capability,
    availability,
    source,
    preferredSource,
    fallbackReason: reason,
    confidence: 'none',
    updatedAt: null,
    metadata
  };
}

export function isUsable(result) {
  return result && result.availability === 'ok';
}

export function rankResult(result) {
  const ranks = {
    ok: 5,
    degraded: 4,
    stale: 3,
    missing: 2,
    error: 1
  };
  return ranks[result?.availability] || 0;
}
