# openplate-core as rootless Quadlet units

The files here come from `docker/compose.yml`. They run Postgres and openplate-core, nothing else. Do not edit the unit files. Change the compose file, then run `scripts/quadlet.sh generate`. This README is the only hand-written file in this directory.

## What is in this directory

- `postgres.container`: `docker.io/library/postgres:17-alpine` on the volume below, `pg_isready` healthcheck as `Notify=healthy`. Not published to the host.
- `sync.container`: openplate-core, `ghcr.io/lowcarbcheck/openplate-core:latest`, published on 3000, `Requires=` and `After=` Postgres, healthcheck against `/health` as `Notify=healthy`. Every optional setting from the compose file (mail, upstream AI, admin token, instance name, reported estimates, push, plans and member invites) is there as an `Environment=` line with its default.
- `postgres-data.volume`: the data volume; Podman names it `systemd-postgres-data`.
- `openplate-core.network`: the private network both join.
- `README.md`: this file.

## The .env file

`sync.container` sets `EnvironmentFile=openplate-core.env`. The path is relative. Quadlet resolves it against the directory of the unit, so put the file beside the units. The unit will not start without it. One key is required:

- `SERVER_SECRET`: `openssl rand -hex 32`. Back it up with the database; a restored database with a lost secret is one nobody can log into.

Do not put any other setting in this file. Podman gives an `Environment=` line priority over the same key in an environment file. Every other setting already has an `Environment=` line in `sync.container`, so a value here has no effect. Change a setting with a drop-in instead: `sync.container.d/local.conf` beside the unit, with a `[Container]` section and one `Environment=KEY=value` line per key. A later `Environment=` line for the same key replaces the earlier one. Keep the drop-in at mode 600 if it holds a token or a key. Do not set `SIGNUP_MODE` or any `SMTP_*`. The service rejects them at boot.

## Install

Put the unit files together in `~/.config/containers/systemd/`. Podman's systemd generator creates services from them during the next `daemon-reload`. You do not need to run `systemctl --user enable`. Every unit includes `WantedBy=default.target`, so the generator sets this up automatically. Running `systemctl --user enable` on a generated unit fails by design.

```sh
mkdir -p ~/.config/containers/systemd/openplate-core
cp docker/quadlet/core/* ~/.config/containers/systemd/openplate-core/
printf 'SERVER_SECRET=%s\n' "$(openssl rand -hex 32)" > ~/.config/containers/systemd/openplate-core/openplate-core.env
chmod 600 ~/.config/containers/systemd/openplate-core/openplate-core.env
systemctl --user daemon-reload
systemctl --user start sync.service
```

Check it:

```sh
systemctl --user is-active postgres.service sync.service
podman ps --filter name=systemd-
curl -s http://127.0.0.1:3000/health
```

**Linger.** A `systemctl --user` service stops when your last session closes. It will not start at boot unless the user's systemd instance starts at boot. Turn on linger once:

```sh
loginctl enable-linger "$USER"
```

**Update.** Pull the new image, then restart the unit:

```sh
podman pull ghcr.io/lowcarbcheck/openplate-core:latest
systemctl --user restart sync.service
```

**Stop and remove.** Run `systemctl --user stop sync.service` to stop the containers. Delete the unit files and run `systemctl --user daemon-reload` to remove the services. Named volumes remain until you delete them with `podman volume rm` (`systemd-postgres-data` here).

## SELinux and rootless notes

**SELinux labels.** This host runs SELinux in enforcing mode. Every mount here uses a named volume (`postgres-data.volume`). Podman labels named volumes for container access at creation time, so these units do not need `:Z`. If you point a mount at a host directory, that changes. A bind mount on an enforcing host requires `:Z` for one container or `:z` for shared access, such as `Volume=/srv/pg-data:/var/lib/postgresql/data:Z`. Without that flag, the container gets `Permission denied` on its data directory.

**Rootless Postgres.** The Postgres image runs as a non-root user inside the container. It runs `chown` on its data directory during the first boot. With a named volume, this works directly. Podman maps the container user into your subordinate UID range and creates the volume to match. The test run below confirmed this. For a bind mount, you must set ownership from the host first. Run `podman unshare chown -R 70:70 ./pg-data` for the alpine image. The alpine image uses UID 70 for `postgres`, while the Debian image uses UID 999. Without this step, the container stops on startup with a permissions error.

**Rootless ports.** The units publish port 3000. That sits above 1024, so it requires no extra privileges. A rootless container cannot bind host ports below 1024 unless configured on the host, such as through `sudo sysctl net.ipv4.ip_unprivileged_port_start=80`. If another process uses port 3000 on your host, change `PublishPort=` in your installed unit under `~/.config/containers/systemd/`. That local file is yours to edit. The unit file in this repository is generated. A drop-in file cannot replace a port mapping. Adding `PublishPort=` to `<unit>.container.d/*.conf` creates a second mapping alongside the first.

**Container and volume names.** Quadlet names containers using the pattern `systemd-<unit>`. For example, `podman ps` shows `systemd-postgres`. A named volume from a `.volume` unit becomes `systemd-<name>`. Within the network, each container also resolves by its compose service name (`postgres, sync`). The generator assigns that name as a network alias. Environment variables like `DATABASE_URL` use this alias.

## Tested on

- Date: 2026-09-14
- Host: Fedora (Bluefin), kernel `7.0.11-200.fc44.x86_64`, SELinux `Enforcing`, no GPU, 16 cores, 60 GiB RAM
- Podman 5.8.4, rootless, as an ordinary user; podlet 0.3.2 generated the units
- Linger was already on for the user (`loginctl show-user $USER -p Linger` printed `Linger=yes`)
- Images: `ghcr.io/lowcarbcheck/openplate:latest` (400 MB), `ghcr.io/lowcarbcheck/openplate-core:latest` (189 MB, serviceVersion 0.15.0), `ghcr.io/lowcarbcheck/openplate-inference:latest` (1.01 GB), `docker.io/library/postgres:17-alpine` (300 MB)

The test used a temporary copy of the unit files under `~/.config/containers/systemd/`, with a new `SERVER_SECRET` in `openplate-core.env` beside them:

```sh
systemctl --user daemon-reload
systemctl --user start sync.service              # returned after 12 s the first time, 31 s with the healthcheck below
systemctl --user is-active postgres.service sync.service   # active, active
podman ps --filter name=systemd-
#   systemd-postgres  Up 47 seconds (healthy)  5432/tcp
#   systemd-sync      Up 31 seconds (healthy)  0.0.0.0:3000->3000/tcp
curl -s http://127.0.0.1:3000/health
#   {"protocolVersion":2,"envelopeVersion":1,"serviceVersion":"0.15.0","instance":{"name":"openplate",...}}  200
```

Outcome: the services started cleanly twice, once before and once after the healthcheck change described below. Fixes from testing the sync scenario earlier that day were already present. The generator used `docker.io/library/postgres:17-alpine` instead of the short image name, because rootless Podman requires a fully qualified name without an interactive terminal. It set `TimeoutStartSec=300` beside `Notify=healthy`, because initial `initdb` execution took 40 seconds against the 45 second default. It also set the service name as a network alias (`Network=openplate-core.network:alias=postgres`). Without that alias, the `postgres` host in `DATABASE_URL` fails to resolve, because Quadlet names the container `systemd-postgres`.

What changed here: the openplate-core image defines a `HEALTHCHECK` against `/health`. Podman discards this check on pull because GHCR serves an OCI manifest, which lacks a health field. During the first test run, `podman ps` showed `systemd-sync` without health status. The compose file now defines this check directly. The unit now includes `Notify=healthy`, and the second run reported `(healthy)`.

After testing, the units were stopped. The test run removed `systemd-postgres-data` and the network, deleted the unit files, and ran `daemon-reload`. Final checks with `podman ps -a`, `podman volume ls`, and `podman network ls` showed no remaining resources from the test.
