# Hook Message Refinements

`matchHealthNoticeText(payload)` is a pure classifier. It returns null or a
sanitized `{sourceId, kind}`; it never returns text, model names or reset times.
The caller applies the structured error and trusted quota-window checks first.
A match cannot establish delivery ownership, health, recovery or quota proof.

Source: https://mia.opencoco.site/review/818-v4.html (v7.9). The collapsed
33-case catalog is historical. Its diagnostic IDs are retained for traceability,
not authorization to enable its old Owner routing or state changes. Factual
first-failure replies for nonquota errors follow the primary Core design's
structured error mapping, independently of the historical text rules.

| Source IDs | Kind | Meaning |
| --- | --- | --- |
| 1, 2, 11 (model variant) | model_quota | Model quota; 2 requires unanswered terminal confirmation |
| 4 (model requires credits), 5 unanswered confirmation | credits_required | Paid usage required; not exhausted model quota |
| 4/10 (out of credits) | credits_exhausted | Paid usage exhausted |
| 4 spend/budget variants, 6-9, 11 (session/weekly), 0 (generic) | quota | Quota/cap diagnostic without inferred reset time or model quota |
| 13 (specific seat/allocation/zero limit) | allocation | Quota allocation unavailable |
| 12 | warning | Approaching quota, not exhausted |
| 25-27 | temporary | Request capacity/network, not quota exhaustion |
| 3, 5 active dialog; 10 organization billing; 14-24; 28-33 | excluded | Diagnostic-only cases outside quota notice scope |

ID 4 includes a few explicit period-separated model-switch variants. Broad
`Switch to another model`, `Could not load`, and `disabled for your org`
fragments are not rules. The matcher does not infer the current model for the
historical Fable branches of IDs 6-10. ID 0 is the unnumbered generic quota row.

The matcher prefers nonempty string `error_details`; otherwise it reads
`last_assistant_message`. Unknown error details do not fall back to assistant
prose. The selected field is rejected above 16 KiB UTF-8, never partially matched.
It folds case, curly apostrophes and whitespace, preserves punctuation, and
accepts one optional API Error/status prefix. All rules start at the diagnostic
prefix, so quoted or explanatory prose containing a signature does not match.
This reduces accidental matches; text itself is not trusted provenance.

Within text matching, warning/capacity rules precede quota text rules. The caller
checks valid full quota windows before using any text result, so even a temporary
text match cannot suppress a proven full-window notice. The result contains only a numeric
source ID and an enum. Raw Hook text must not be persisted or included in a
notice by this matcher. Platform wording overrides belong to the template layer.
