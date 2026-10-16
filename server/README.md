# Obsidian Live Share relay package

Requires Node.js 20.19 or newer and npm. The Obsidian plugin is installed
separately on each participant's machine.

Build a package from a checkout:

```sh
npm ci
npm pack
```

Install the resulting package:

```sh
npm install --global /path/to/obsidian-live-share-server-0.1.0.tgz
obsidian-live-share-relay run --port 3865
```

The CLI uses `~/my-services/obsidian-live-share-relay` by default. `--directory`
selects another location. A first run creates `.env` with a random server password
and JWT secret; subsequent runs preserve them. Find the server password in that
file and enter it in the Obsidian plugin settings. `data/` contains room metadata
and `logs/` contains background-service logs. Document contents remain in the
participants' Obsidian vaults.

`--host 127.0.0.1` limits a relay to this machine. With no host setting, the server
uses Node's normal listener binding. `PORT`, `HOST`, TLS and other server settings
can also be configured in `.env`. Explicit `--port` and `--host` update those two
configuration values; other existing lines and credentials are preserved.

## macOS background service

After installing the package globally:

```sh
obsidian-live-share-relay install-service --port 3865
obsidian-live-share-relay status
obsidian-live-share-relay uninstall-service
```

This creates a per-user launchd job that starts at login and restarts the relay
if it exits. It does not require sudo. The job points to the installed package and
Node executable: retain those installations, or reinstall the service after
moving or upgrading them. Running `install-service` again with the same options
leaves a loaded service alone. To change a running service's options, uninstall its job
first, then install it again. Removing the job retains configuration, data, and
logs. Use the same `--directory` for all commands when choosing a custom location.

Native service commands are macOS-only; `run` is the foreground entry point on
other Node.js platforms. The repository also includes a Docker Compose setup.
The CLI package does not keep Obsidian itself running: a shared session still
requires its host vault to be open.

## Package validation

```sh
npm run test:package
# On macOS, also exercise a temporary launchd service:
npm run test:service
```

This packs and globally installs into a temporary prefix, then runs the actual
installed executable with a temporary data directory and loopback-only listener.
It checks authentication, shutdown, restart and room persistence. The service
check also verifies installation, status, repeated installation,
and removal while retaining data. Both checks use a temporary installation;
they do not replace an existing relay. These smoke scripts require Unix executable
links; Windows foreground support is not exercised by them. With TLS configured,
service startup checks listener readiness; otherwise it checks `/healthz`.
