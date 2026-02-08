# ideas.md Format

## Purpose

Uncommitted plans, explorations, hypotheses, and building ideas.
An idea becomes a project when work begins, or a decision when
commitment is made.

## Location

`reference/ideas.md`

## Size Guideline

No hard cap. Maintain via entry lifecycle (drop or promote entries).

## Entry Format

```markdown
### [Idea Title]
- **Date:** YYYY-MM-DD
- **Source:** [who suggested it, or where it came from]
- **Status:** raw | exploring | ready-to-commit | dropped
- **Importance:** 1-5 (1=critical, 5=minor)
- **Type:** strategic | experiential
- **Description:** [what the idea is]
- **Related:** [links to relevant decisions, projects, or other ideas]
```

## Status Values

- **raw**: just captured, no evaluation yet.
- **exploring**: actively being investigated.
- **ready-to-commit**: evaluated and ready to become a project or decision.
- **dropped**: considered and rejected.

See `examples/ideas.md` for a full example.

## Rules

1. Must be uncommitted. Once work begins, it becomes a project. Once
   committed, it becomes a decision.
2. NOT ideas: things already decided (-> decisions.md), things actively
   being built (-> projects.md), config data (-> references.md).
3. Dropped ideas are candidates for archival during consolidation review.
4. The Related field helps trace idea lineage.
