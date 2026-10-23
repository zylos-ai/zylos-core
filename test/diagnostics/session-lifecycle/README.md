# Session lifecycle diagnostics

These opt-in Linux probes investigate tmux creation and process termination. They do not invoke model CLIs, use a default tmux socket, or validate the product adapter. They retain temporary evidence and stop only their own processes.

- `python3 reproduce.py`: creation versus exec, submission timeout, and external-gate cancellation observations; see [launch notes](launch-probe.md).
- `python3 dequeued-fork.py`: optional debugger probe of client disconnect after creation has started; requires GDB and a tmux binary with the symbols used by the probe.
- `python3 stop-probe.py`: controlled parent/descendant termination and unconfirmed outcomes; see [stop notes](stop-probe.md).

Run these manually in a suitable test environment. They are diagnostics, not release acceptance tests. Platform/version limitations and remaining ownership or cancellation gaps are documented in the linked notes.
