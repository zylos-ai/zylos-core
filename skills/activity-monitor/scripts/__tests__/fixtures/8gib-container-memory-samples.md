# 8 GiB Container Memory Samples

Real sampling from an 8 GiB cgroup v2 container, with timestamps shifted to a
fictional start hour on 2026-01-05 and numeric values unchanged. All timestamps
and the replay reference time move by the same integer-hour offset, preserving
sample intervals, UTC hourly groups and the seven-day window.

The fixture contains 5,652 rows, sorted by timestamp, in
`1767760262245 - 7 days < ts <= 1767760262245`. Qualifying buckets n=1/2/3/4
cover 38/35/9/6 hours respectively. Samples use version 2 for replay.
Historical memory values include active file cache; they do not measure the
new memory reader.
