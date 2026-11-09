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
```
- The image bundles the Docker CLI with the **buildx** plugin. Without buildx, every Docker or Nixpacks build fails with "BuildKit is enabled but the buildx component is missing".
- At startup the runner logs whether buildx is available, so check `docker compose ... logs runner` after an update.
- App containers the runner started keep running across a runner restart. Redeploy a service to re-register it with the new runner process.

## Operations
- **Logs:** `docker compose -f deploy/alibaba-ecs/docker-compose.yml logs -f runner`
- **Update:** `git pull && sudo docker compose -f deploy/alibaba-ecs/docker-compose.yml up -d --build`
- **Managed databases:** `RUNNER_DB_MODE=docker` starts Postgres, Redis and MySQL as containers on this host. `RUNNER_DB_HOST` is the address put into their connection URLs. Use the private VPC IP for apps on this host. Only open the database ports in the security group if something outside the instance must connect.
- **Behind NAT instead** (a home machine, or a host with no public IP): keep Cloudflare Tunnel (`TUNNEL_DRIVER=cloudflare` with `CLOUDFLARE_TUNNEL_TOKEN`) and drop the caddy service. Use the tunnel hostname as `RUNNER_URL`.
