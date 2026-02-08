# projects.md Format

## Purpose

Records of work efforts with a defined scope and lifecycle. A project has
a beginning, active work, and eventual completion or abandonment.

## Location

`reference/projects.md`

## Size Guideline

No hard cap. Maintain via entry lifecycle (archive completed/abandoned entries).

## Entry Format

```markdown
### [Project Name]
- **Status:** planning | active | paused | completed | abandoned
- **Started:** YYYY-MM-DD
- **Updated:** YYYY-MM-DD
- **Description:** [what this project is]
- **Importance:** 1-5 (1=critical, 5=minor)
- **Type:** factual
```

## Status Values

- **planning**: scoped but not started.
- **active**: work in progress.
- **paused**: temporarily on hold.
- **completed**: finished successfully.
- **abandoned**: stopped without completion.

See `examples/projects.md` for a full example.

## Rules

1. Must be a work effort with defined scope. One-off tasks go in `state.md`.
2. NOT projects: decisions about how to build (-> decisions.md), wishes
   for future work (-> ideas.md).
3. Update the **Updated** date whenever status changes.
4. Completed/abandoned projects are candidates for archival during
   consolidation review.
