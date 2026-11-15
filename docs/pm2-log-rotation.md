# PM2 log rotation

Every Zylos service and component runs under PM2 and writes its output to PM2
log files (for example `~/zylos/components/<name>/logs/out.log` and
`error.log`). PM2 does not rotate these files on its own. Zylos makes sure the
PM2 module [`pm2-logrotate`](https://github.com/pm2-hive/pm2-logrotate) is
present, and that one module rotates the logs of all PM2 processes, including
PM2's own `pm2.log`. Services and components do not truncate their PM2 log
files themselves.

## When Zylos installs it

`zylos init` and `zylos upgrade --self` check the current PM2 home
(`$PM2_HOME`, default `~/.pm2`) after the services have started:

- **Module missing**: Zylos writes the default settings below, then runs
  `pm2 install pm2-logrotate`.
- **Module already present** (recorded by PM2 in `module_conf.json`): Zylos
  leaves it and all of its settings unchanged, including values you changed.

Existing installations get the module at their next approved
`zylos upgrade --self` (or the next `zylos init`). Installing it adds one PM2
module process; no service or component is restarted.

## Default settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `max_size` | `10M` | Rotate a log file once it is at least this size when checked |
| `retain` | `7` | Keep at most 7 rotated files per log file; older ones are deleted |
| `compress` | `true` | Compress rotated files with gzip (`.gz`) |
| `workerInterval` | `30` | Check file sizes every 30 seconds |
| `rotateInterval` | `0 0 * * *` | Also rotate every non-empty log daily at midnight |

`max_size` is a rotation threshold checked every `workerInterval` seconds, not
a hard limit: a log can grow past 10 MB between two checks and is rotated at
the next one. The daily rotation uses the local time of the PM2 daemon unless
you set the module's `TZ` setting.

## Changing the settings

Show the current values:

```bash
pm2 conf pm2-logrotate
```

Change a value, for example keep 14 rotated files:

```bash
pm2 set pm2-logrotate:retain 14
```

Each `pm2 set pm2-logrotate:<key>` restarts only the `pm2-logrotate` module.
Zylos never overwrites these values once the module is installed. If you
uninstall the module with `pm2 uninstall pm2-logrotate`, the next `zylos init`
or `zylos upgrade --self` installs it again with the defaults.

## When installation fails

Installing the module needs npm access to the registry. Without network
access, or when npm or PM2 fails, init and upgrade still finish and report
success. They print one warning that names the cause and the command to run
later, for example:

```text
Upgrade warning: PM2 log rotation is not installed (pm2 install exited with 1: npm error network request failed). PM2 logs of Zylos services and components will not be rotated automatically. Install it later with: pm2 set pm2-logrotate:max_size 10M && pm2 set pm2-logrotate:retain 7 && pm2 set pm2-logrotate:compress true && pm2 set pm2-logrotate:workerInterval 30 && pm2 set pm2-logrotate:rotateInterval '0 0 * * *' && pm2 install pm2-logrotate
```

Until that command succeeds, PM2 logs grow without rotation. Each `pm2 set`
step may take at most 20 seconds and `pm2 install` at most 180 seconds; a step
that runs longer is stopped together with the npm process it started, and the
warning reports the timeout. If PM2's module record file cannot be read, Zylos
changes nothing and the warning asks you to check `pm2 ls` before installing.

## Existing large log files

The module checks every PM2 log file within 30 seconds of starting. A file
already over 10 MB is rotated at that first check: its content is copied to a
compressed archive next to it, named
`<file>__<YYYY-MM-DD_HH-mm-ss><extension>.gz` (for example
`out__2026-11-16_00-00-00.log.gz`), and the original file is then truncated
in place while the process keeps writing to it. The archive is kept like any
other rotated file and is deleted only when more than 7 newer archives of the
same log exist. Compressing a very large file takes some time and needs free
disk space for the compressed copy.

## Docker

In the official Docker image the PM2 home (`/home/zylos/.pm2`) is not part of
the `zylos-data` volume, so `zylos init` installs the module again at each
container start. Without network access, each start prints the warning above
and logs are not rotated in that container.
