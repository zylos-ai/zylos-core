# Per-round measurement method

The same external `round-probe.test.js` uses the official Node runner and shared readyTmuxTarget fixture with real isolated tmux 3.7c sessions, the actual createSupervisor composition, and actual process sampling. A shell wrapper counts each tmux subprocess. Setup, warmup, and cleanup are excluded. Five quiet rounds advance the fixture clock by 61 seconds, covering periodic Sync/maintenance. Fixtures contain one Origin or Origin plus three groups, with an empty synthetic database. No pending messages, fences, requests, or mutations occur. Wrapper overhead and host load affect elapsed time.

Scope excludes supervisor-main legacy and machine-task afterRound hooks. These numbers are not whole-daemon or active-action benchmarks. Mutation paths deliberately perform fresh checks and can issue more calls.

Baseline source is old C `1030a56da625093ae5d1c609fd8fff29af3be1f7`. The first baseline attempt exposed a missing fixture getLastActivity method for the multi-group case; its failure log is retained. The fixture was completed with a current activity timestamp, then both cases passed. Product source was not altered for the benchmark.

Final source is C `9513d8522688b72fa177328dc3b1db9a2b7dc79a`. Final measured calls were 23 per Origin-only round and 89 per four-group round, with median elapsed 101.083 ms and 388.239 ms respectively. Baseline calls were 94 and 394, median 614.249 ms and 3157.903 ms. All five samples have those call counts. `round-probe-source-verification.json` verifies 338 source files match the final probe copy and C matrix source manifest. Raw sample JSON contains counters, elapsed values and maxima.
