# Darwin process-image capability probe

`darwin-observation-probe.c` is an opt-in diagnostic for the process-image
observation used by launch/isRunning. It only examines a synthetic child.
It is not part of stop, which manages only its verified tmux object.

On macOS with an existing C toolchain:

```sh
cc -Wall -Wextra -Werror darwin-observation-probe.c -lproc -o /tmp/p02-darwin-probe
/tmp/p02-darwin-probe
```

No toolchain is installed. The probe compares native libproc identity before
and after executable/cwd/argv/environment observations. Non-Darwin execution
returns 78/not-run and does not validate the Darwin branch. This source has not
established native Mac acceptance or an atomic snapshot across same-PID exec.

The retired stop PID-reuse/pidfd experiments are available in commit
`de0c7822ace8f134da6b58e408a55e93c4f5ace2`; their source, helper, build script,
and distribution requirements are not current stop behavior or acceptance.
