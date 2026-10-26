# Session log format

Use `sessions/YYYY-MM-DD.md` under the current scope's memory directory. The
date is taken from configured TZ. Append with `memory-append.js session`,
passing text on stdin; multiline details are allowed. Never create current.md.

```markdown
## 13:30 - Validated the proposal
- Confirmed the expected result in the staging fixture.
- Recorded the remaining approval as a pending item.
```

Keep concise work history: what happened, why, and pointers to detailed evidence.
Do not rewrite earlier entries. Session logs support Sync's factual checks but
do not replace inbox commitments or guarded checkpoints. During upgrade only,
`rotate-session.js` archives any legacy current.md using its header date (mtime
if no date), preserving collisions and never creating a new current.md.
