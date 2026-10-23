# Historical legacy process-discovery experiment

`legacy-orphan-probe.py` is a retained standalone historical experiment, not
current stop behavior or acceptance. Its former process-ownership requirement
was retired: stop does not discover or terminate historical descendants and
must not reject a readable legacy tmux target merely for lacking a run ID.
The old investigation is recorded at commit
`847a0bc65ac98451abd511ebc64c351fec624ead`.

The standalone script's own isolated cleanup is an experiment detail, not a
product pidfd dependency. No current module imports it, and no normal test,
build, installer or runtime invokes it. Current historical-null target behavior
is covered by `legacy-stop-matrix.test.js`.
