# B7 independent inspection at 20f274a

Reviewed component restartAfterSelfUpgrade extraction, restart.main injection and restart-producers-acceptance.test.js. No behavior bug found and no code changed.

The extracted helper preserves the former success+instructionFilesRebuilt gate, request options, single request, error mapping and warnings. upgradeSelfCore calls the helper at the original position after upgrade/cleanup. restart.main defaults to the real requestRuntimeRestart and supports injected submission. Acceptance now imports production modules directly; no source rewriting/data URLs/global registry remains. Real isolated Unix socket accepted/rejected/partial/timeout cases still assert exactly one request and uncertainty lookup. The component test's limited scope is correctly titled: actual post-install restart step plus existing reply formatter, not complete installation/CLI orchestration. Retained targeted log records 9 passes; not rerun during this inspection.

The explicit injection parameter is requestRestart (matching upgradeRuntime's established API); no contract issue. Whole repository Node/Jest execution awaits root's final B freeze instruction.
