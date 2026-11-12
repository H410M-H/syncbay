# Self-host the Syncbay runner on Alibaba Cloud ECS (or any VPS)

The control plane (syncbay.app on Vercel) forwards every `*.syncbay.app` request to one public runner URL, `RUNNER_URL`, and sets `x-target-port`. On a server with a public IP you don't need a tunnel. This kit runs two containers:

- **runner**: the Syncbay runner daemon. It drives the host Docker daemon and runs customer apps on host ports 10000–60000.
- **caddy**: serves `https://runner.syncbay.app` with an automatic Let's Encrypt certificate and proxies to the runner on `127.0.0.1:8080`.

```
browser ─▶ *.syncbay.app (Vercel proxy) ─▶ https://runner.syncbay.app (Caddy :443) ─▶ runner :8080 ─▶ app :10000+
```

## 1. Create the instance
- **Image:** Ubuntu 22.04/24.04 or Alibaba Cloud Linux 3. Both x86 (amd64) and ARM (arm64) work; the image is multi-arch.
- **Size:** 1 vCPU / 1 GiB, as on the free-trial `t5`/`t6`, is enough for small apps. `setup.sh` adds 2 GiB of swap for builds, but 2 GiB RAM or more is more comfortable.
- **Security group:** open only **80** (for the ACME challenge) and **443**, plus 22 for SSH. Keep 8080 and 10000–60000 closed, because Caddy is the only public entry point.
- **IP:** give the instance a public IP, or attach an EIP so the address survives a stop.

## 2. DNS
In Cloudflare DNS for `syncbay.app`, add:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `runner` | `<ECS public IP>` | **DNS only** (grey cloud) |

Caddy completes the ACME challenge itself. You can switch the record to "Proxied" later, as long as Cloudflare SSL mode is "Full (strict)".

## 3. Install and start
```bash
git clone https://github.com/H410M-H/syncbay.git && cd syncbay
sudo bash deploy/alibaba-ecs/setup.sh   # 1st run: installs Docker, adds swap, writes .env with a fresh RUNNER_SECRET
nano deploy/alibaba-ecs/.env            # set RUNNER_DOMAIN, RUNNER_TLS (your email), RUNNER_DB_HOST
sudo bash deploy/alibaba-ecs/setup.sh   # 2nd run: docker compose up -d --build
curl -fsS https://runner.syncbay.app/health
```

## 4. Point the control plane at it
In Vercel → Project → Settings → Environment Variables (Production):

| Name | Value |
| --- | --- |
| `RUNNER_URL` | `https://runner.syncbay.app` |
| `RUNNER_SECRET` | the exact value from `deploy/alibaba-ecs/.env` |
| `RUNNER_DRIVER` | `webhook` |

Then redeploy. New deployments are dispatched to the ECS runner, and requests to their `*.syncbay.app` hosts are proxied to it.

## Updating the runner
Run this on the server after new runner changes land on `main`:
```bash
cd /opt/syncbay && git pull && docker compose -f deploy/alibaba-ecs/docker-compose.yml up -d --build
docker compose -f deploy/alibaba-ecs/docker-compose.yml exec runner docker buildx version   # must print a version
curl -fsS https://runner.syncbay.app/health   # "version" must match runner/src/version.ts and "startedAt" must be recent
```
- The image bundles the Docker CLI with the **buildx** plugin. Without buildx, every Docker or Nixpacks build fails with "BuildKit is enabled but the buildx component is missing".
- Two more safeguards cover an old or broken image:
  - Compose also mounts the host's plugin directory, `/usr/libexec/docker/cli-plugins`, read-only. Docker from `get.docker.com` (which `setup.sh` uses) puts `docker-buildx-plugin` there.
  - At startup, and again before each build, the runner checks `docker buildx version`. If buildx is missing, it downloads the plugin (`RUNNER_BUILDX_VERSION`, default 0.17.1) into `~/.docker/cli-plugins`. Set `RUNNER_AUTO_INSTALL_BUILDX=false` to turn this off.
- `curl -fsS https://runner.syncbay.app/health` reports `toolchain: { docker, buildx, nixpacks }`. The dashboard's runner card warns when buildx is missing.
- If `up -d --build` fails, compose keeps the **old** container running. Check the end of its output (GitHub release downloads sometimes time out; the Dockerfile retries them), then run it again.
- App containers the runner started keep running across a runner restart. Redeploy a service to re-register it with the new runner process.

## Operations
- **Logs:** `docker compose -f deploy/alibaba-ecs/docker-compose.yml logs -f runner`
- **Update:** `git pull && sudo docker compose -f deploy/alibaba-ecs/docker-compose.yml up -d --build`
- **Managed databases:** `RUNNER_DB_MODE=docker` starts Postgres, Redis and MySQL as containers on this host.
  - `RUNNER_DB_HOST` is the address written into connection URLs, for external tools. Set it to the server's public IP or a DNS name.
  - Apps deployed on this host do not use that address. The runner points their database URLs at the Docker bridge gateway (`RUNNER_DB_INTERNAL_HOST` overrides it), so they connect without any port being open.
  - **pgAdmin / DBeaver from your computer: use an SSH tunnel** (nothing to open). pgAdmin → Register Server → *SSH Tunnel*: host `47.237.1.136`, port 22, user `root`, your SSH key. *Connection*: host `127.0.0.1`, port = the database port (e.g. `10001`), database `main`, user `postgres`, password from the connection URL. Terminal alternative: `ssh -N -L 15432:127.0.0.1:10001 root@47.237.1.136`, then connect to `127.0.0.1:15432`.
  - New databases get a host port from `RUNNER_DB_PORT_RANGE` (default `54320-54399` in this kit). Open that range in the security group only if pgAdmin, `psql` or Query Studio must connect from outside. A database created earlier keeps its port (for example 10001); open that one port, or recreate the database.
- **Start-up checks:** a new instance has 120 s (`RUNNER_HEALTH_TIMEOUT_MS`) to answer HTTP. If the app listens on another port than the service's port, the runner finds it and re-maps. An app bound to `127.0.0.1` cannot be reached; bind it to `0.0.0.0`.
- **Builds:** at most 2 at once (`RUNNER_MAX_CONCURRENT_BUILDS`; use 1 on a 1–2 GiB host). Node projects that pin no version build with Node 22 (`RUNNER_DEFAULT_NODE_VERSION`).
- **Behind NAT instead** (a home machine, or a host with no public IP): keep Cloudflare Tunnel (`TUNNEL_DRIVER=cloudflare` with `CLOUDFLARE_TUNNEL_TOKEN`) and drop the caddy service. Use the tunnel hostname as `RUNNER_URL`.
