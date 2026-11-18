# Candidate-text memory budget API

## Availability and entry point

Components using this API must declare a minimum Core version of
`1.0.0-beta.14` (the first release containing it). Import the documented export
from the installed Core skills root, not activity-monitor internals:

```js
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { measureMemoryText } = await import(pathToFileURL(path.join(
  skillsDir, 'zylos-memory/scripts/memory-budget.js')).href);
const result = measureMemoryText('identity.md', candidateText);
```

`skillsDir` is the installed Core skills directory resolved by the component's
existing Core loader. The synchronous function reads no file, writes nothing,
and uses no network. It measures the complete raw candidate string, including
whitespace (startup trims it, so reporting may be conservative). Unknown file
names and non-string text throw. The result is reporting only: warning and over
statuses must not prevent writes or trigger extra owner/system alerts.

## Startup files

`identity.md` and `references.md` return:

- `chars`: JavaScript string length (UTF-16 code units).
- `estimatedTokens`: the same rounded estimator used by startup.
- `sizeBytes`: UTF-8 byte count, for file-size reporting only.
- `maxChars`, `maxTokens`: the uniform body limits, derived from the startup
  dual budget minus its longest header and section labels; do not hard-code them.
- `warnThreshold`: `{chars, estimatedTokens}`, each 80% of its corresponding limit.
- `status`: `over` if either limit is exceeded; otherwise `warning` if either
  warning threshold is reached (inclusive); otherwise `ok`.
- `budgetUsagePct`: rounded larger percentage of the two dimensions.

The wrapper reserve uses the shard-name length bound and the decimal width of
`Number.MAX_SAFE_INTEGER` for positions, totals and waiting milliseconds. Both
files reserve the longest section label and predecessor-wait header, even though
identity is normally first and has no predecessor. Thus a passing result always
fits startup; a conservatively over-limit result can still fit a shorter normal
header. Runtime selection does not change the limits.

Truncated startup blocks put a notice immediately after the numbered header,
showing the retained amount and the path of the full copy to read first.

## Reference indexes

`reference/projects/INDEX.md` and `reference/decisions/INDEX.md` retain byte
budgets: `sizeBytes`, `budgetBytes` (32 KiB), `warnBytes` (16 KiB), `status`, and
`budgetUsagePct`. Their existing warning comparison is strictly above 16 KiB.
Other memory files have no budget from this API.
