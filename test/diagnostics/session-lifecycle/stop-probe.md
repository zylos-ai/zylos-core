# Historical stop mechanism experiment

This document and `stop-probe.py` describe a retired process-termination
experiment, retained only for history. They are not current stop acceptance,
do not define ownership, and do not justify scanning or signalling inherited
run IDs. The old investigation is recorded at commit
`847a0bc65ac98451abd511ebc64c351fec624ead`.

Current stop closes and confirms only the verified original tmux object.
Independent services may inherit the same run environment and must survive.
Use the normal `session-stop-*.test.js` suites for current behavior. The
standalone historical Python probe has no imports of removed production
modules; it is not invoked by the test runner, build, installation or runtime.
