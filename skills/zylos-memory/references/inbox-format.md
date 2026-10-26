# Inbox format

Use `memory-append.js inbox --kind commitment|decision|fact`, passing one nonempty
body line on stdin. The script selects the current scope, holds the shared
memory lock, and appends:

```text
### 2026-10-19
- 13:30 commitment: Send the revised proposal after validation.
- 13:31 decision: Keep the public API stable.
- 13:32 fact: The staging run completed successfully.
```

Dates and times use configured TZ. Do not append with shell redirects or retain
an open file handle: Sync rotates inbox to `inbox.<UTC-segment-ID>.md`. The
shared lock makes append and rotation exclusive. If append fails, report that
it was not recorded and retry through the script; do not claim success.

Sync consumes nonempty segments only when it has new C4 input. It includes
absorbed items in the summary, records committed segment IDs in state, and
removes only those segments after state publication.
