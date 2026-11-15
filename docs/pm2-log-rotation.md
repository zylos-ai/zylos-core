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
  `pm2 install pm2-logrotate` using npm, even when bun is on PATH (including snap-packaged bun).
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
later. The warning preserves up to eight error lines from stdout and stderr
(up to 2,000 characters), including the underlying npm error before PM2's
generic failure message.

The printed command runs `pm2-logrotate-install.js` with the current Node
executable. This uses the same defaults, npm selection and deadlines as init
and upgrade; it leaves an already installed module unchanged. It does not
change the user's global PATH or uninstall bun. PATH directories containing bun
are replaced for the install process by symlink directories containing the other
tools. These live under the module's own `.zylos-npm-path` directory, because PM2
passes PATH to the running module; they remain usable after installation and
are removed together with the module on uninstall.

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

The official Docker image runs `zylos init` at every container start (see
[Docker](docker.md)), so every start checks for the module. The PM2 home
(`/home/zylos/.pm2`) is not part of the `zylos-data` volume: a restarted
container keeps a module it already installed, but a newly created container,
for example after `docker compose pull && docker compose up -d`, starts without
it and installs it again.

### Startup wait without network access

With network access the install usually finishes within a few seconds. Once
the module is installed, later starts of the same container find it and do not
wait.

Without network access, the start waits for `pm2 install pm2-logrotate` until
npm gives up or the 180-second install timeout is reached, whichever comes
first. When npm is configured to use a proxy that never responds, npm does not
give up by itself and the start waits the full 180 seconds; Zylos then stops
the install and prints the warning above. The `pm2 set` steps before the
install do not use the network and finish quickly. The wait happens in the
entrypoint's "Initializing workspace" step, after `zylos init` has started the
PM2 services and before the agent runtime session starts, so the container
becomes ready correspondingly later. Logs are not rotated in that container,
and the wait repeats at every start until the module is installed.

To avoid the wait, use one of the following:

- **Give npm a working route to the registry.** `pm2 install` runs npm with
  the environment of the container, so npm's standard settings apply. In the
  `environment` section of `docker-compose.yml`, set `HTTPS_PROXY` and
  `HTTP_PROXY` to a proxy that responds, or set `NPM_CONFIG_REGISTRY` to a
  registry mirror the container can reach. Remove proxy settings that point to
  an unreachable proxy.
- **Install the module in your own image.** Build an image on top of the
  official one that installs the module with the default settings while the
  build still has network access:

  ```dockerfile
  FROM ghcr.io/zylos-ai/zylos-core:latest
  RUN node "$(npm root -g)/zylos/cli/lib/pm2-logrotate-install.js" \
   && pm2 kill
  ```

  The module and its settings are then part of the image's PM2 home. At each
  start `zylos init` finds the module record, leaves the module unchanged and
  runs no npm command, and PM2 starts the module together with the services.
