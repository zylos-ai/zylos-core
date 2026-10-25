# Unobservable-server alert interval correction

The first alert remains due after 60 seconds. Repeated alerts are now due only after 30 minutes since the previous notification (previously 10 minutes), as requested in the approved follow-up. The regression checks no alert at the former 10-minute boundary, none at 30 minutes minus 1 ms, and exactly one at 30 minutes; concurrent fallback notification coverage uses the new interval too.

Official isolated runner:

```sh
node scripts/run-node-tests.js skills/activity-monitor/scripts/__tests__/supervisor-server-health.test.js skills/activity-monitor/scripts/__tests__/supervisor-server-observation.test.js
```

See alert-tests.log for exact counts. This revision changes only the interval constant/comment and corresponding deterministic clock tests. It does not change tmux commands, formats, parsing, observation, or stop paths; the five-version matrix from the preceding stack revision was not rerun for this clock-only change. Prior evidence remains historical for its recorded source hashes.
