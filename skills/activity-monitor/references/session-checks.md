# Reclaim and Restart Checks

Before a session group is reclaimed or restarted, it receives a one-line
control that states the reason and names one of these checks:

- **Idle reclaim check**: the group has been idle and will be reclaimed (TTL
  reclaim and capacity or memory-pressure eviction).
- **Upgrade restart check**: the group will be restarted for an upgrade.
- **Configuration restart check**: the launch configuration changed and the
  group will be restarted with it.

Run the named check now, following the steps below in order. During this
check, do not send messages to anyone.

The commands below run installed CLIs; if Zylos is not installed at
`~/zylos`, use the actual installation directory. Run them in this session:
they inherit this session's group and run identity.

## 1. Running work

- **Idle reclaim check:** Only one thing can hold the reclaim: work this
  session itself started that is still running and whose result it is waiting
  for — a background command, a Monitor watcher, a background subagent or
  workflow. A Memory Sync is not such work: the supervisor already waits for it
  before reclaiming, so do not defer for it. If there is such work, run
  `node ~/zylos/.claude/skills/activity-monitor/scripts/supervisor-request.js defer-reclaim --reason "<what is still running>"`,
  confirm it reports ok:true, then acknowledge this control.
- **Upgrade and configuration restart checks:** If work
  this session itself started is still running (a background command, a
  Monitor watcher, a background subagent or workflow), it will be interrupted
  by this restart: name it in the session handoff so the next session can rerun
  or check it.

## 2. Handoff

Otherwise write the session handoff: list open business items as they stand
now, checking each against its current record and leaving out any that have
finished. Replies, reviews or decisions you are waiting for from people or
other sessions need nothing more: an incoming reply wakes this group again.

## 3. Wake-ups

Create a wake-up only for a step of your own ongoing task that waits on an
external system whose result will not arrive as a message to this group (for
example CI on a PR you opened, or a deployment rolling out). First run
`node ~/zylos/.claude/skills/scheduler/scripts/cli.js list --json`; if a
pending task of this group already covers it, do not create another. Otherwise
run `node ~/zylos/.claude/skills/scheduler/scripts/cli.js add "<self-contained check>" --in "<delay>" --json`
in this session without any --reply option, and confirm it reports ok:true.
Do not create scheduled tasks for anything else.

## 4. Finish

- **Idle reclaim and upgrade restart checks:** Then
  acknowledge.
- **Configuration restart check:** Then submit ready_for_config_reclaim through
  the supervisor. After acceptance, finish this control and the current turn.
