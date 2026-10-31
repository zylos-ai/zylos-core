# P07 external model driver protocol (v1)

Opt-in env `MODEL_WORKFLOW_DRIVER` is an absolute executable path. Optional `MODEL_WORKFLOW_DRIVER_ARGS` is a JSON array of strings (for example node + absolute .mjs). Harness starts it separately per scenario. It inherits test environment, not host credentials. stdout is JSONL protocol only, stderr diagnostics. Harness sends one JSON object per line:

- `{type:"start", protocol:1, scenarioId, prompt, tools:[{name,description,inputSchema}], context:{scope,kind,root,memoryDir,runId}, evidenceDir}`. `prompt` includes real repository SKILL and complete procedure, observed input facts; no oracle IDs. `root` is isolated. `evidenceDir` is output-only metadata and must not be read for expected answers.
- `{type:"tool_result", id, result}` in reply to driver request. Results are real script status/stdout/stderr, file contents/list, or actual MCP result.

Driver emits:
- `{type:"tool_call", id:"unique-string", name:"read_file"|"list_files"|"run_script"|"edit_memory", arguments:{...}}`.
- `read_file`: `{path}` relative to isolated root (or allowed absolute fixture path); max complete input 2 MiB.
- `list_files`: `{path}` returns relative directory entries.
- `run_script`: `{script:"sync-lock"|"sync-files"|"origin-cursor"|"request-rotation"|"c4-db"|"c4-fetch", args:["..."], stdin?:"..."}`. Names select repository's real CLI; no shell/eval or environment overrides. All process environment comes from fixture.
- `edit_memory`: the exact production `{op,path,expected?,replacement,token}` schema, relayed to real stdio MCP server.
- `{type:"final", text:"human-readable report", usage?:{...}, model?:"actual model", modelCalls?:number}`. Driver must exit0 after final. Harness checks results independently. Real provenance recorded by external driver; a label alone is not proof.

`MODEL_WORKFLOW_CASES` comma-separated scenario IDs optionally narrows execution. No live model by default; omitted driver means real-model tests are explicitly skipped. Each case timeout 10 minutes and max100 tool calls. Test artifacts contain actual commands/input/outputs and hashes, no credentials. Driver must execute model-requested tools through this protocol, never alter fixture directly. Fault injection is harness-owned and explicitly marked in trace.

## Running

Run the offline transport/observer checks through the repository runner:

```sh
node scripts/run-node-tests.js skills/zylos-memory/scripts/tests/model-workflow.integration.test.js
```

To run live cases, supply a model-backed executable implementing the protocol above:

```sh
MODEL_WORKFLOW_DRIVER=/absolute/path/to/model-driver \
MODEL_WORKFLOW_EVIDENCE_DIR=/absolute/path/to/evidence \
node scripts/run-node-tests.js skills/zylos-memory/scripts/tests/model-workflow.integration.test.js
```

The driver must forward the complete start prompt and tool schemas to a real model and relay its requests/results. It must not calculate expected IDs, read harness source or evidence snapshots, or implement the Sync procedure itself. Keep model access credentials in the external driver; fixture tool processes run with their isolated environment. Native agent bridges may orchestrate requests outside the fixture, while all memory reads/writes still pass through the declared tools.

`MODEL_WORKFLOW_CASES` selects comma-separated names from the live tests. Each of the three follow-up cases starts three fresh model sessions against the same evolving fixture. Record real worker/provider invocation counts separately: a native worker can make several provider calls, and unavailable token usage must remain unavailable. Include driver/model provenance and all failed attempts when reporting acceptance.

Default transport tests use a deterministic single-read driver and explicitly report zero model calls. Their success never substitutes for live acceptance. The harness exercises model-chosen real CLI/MCP operations; it does not establish native runtime configuration or process lifecycle behavior.
