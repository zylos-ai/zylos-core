# decisions.md Format

## Purpose

Records of deliberate choices that constrain future behavior. A decision
has a clear moment of commitment ("we decided to...") and closes off
alternatives.

## Location

`reference/decisions.md`

## Size Guideline

No hard cap. Maintain via entry lifecycle (archive superseded/old entries).

## Entry Format

```markdown
### [Decision Title]
- **Date:** YYYY-MM-DD
- **Decided by:** [who]
- **Decision:** [what was decided]
- **Context:** [why this was decided, alternatives considered]
- **Status:** active | superseded | archived
- **Importance:** 1-5 (1=critical, 5=minor)
- **Type:** strategic | procedural
```

## Status Values

- **active**: currently in effect.
- **superseded**: replaced by a newer decision (note which one).
- **archived**: no longer relevant.

See `examples/decisions.md` for a full example.

## Rules

1. Must be a deliberate choice with commitment. "We should..." is an idea,
   not a decision.
2. NOT decisions: user preferences (-> preferences.md), project status
   updates (-> projects.md), ideas not yet committed to (-> ideas.md).
3. When superseded, update status and link to the replacement decision.
4. Importance 1-2 entries are immune to automatic fading suggestions.
