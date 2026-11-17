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
The `updater` service does this automatically: every 10 minutes it pulls `main` and, when runner code changed, rebuilds and restarts the runner (apps and databases keep running). Its last result is on `/health` under `update` and on the dashboard; `docker compose -f deploy/alibaba-ecs/docker-compose.yml logs updater` shows the details. Set `RUNNER_AUTO_UPDATE=false` in `.env` to update by hand only.

The updater only exists after the first update that includes it, so a server set up before November 2026 needs this once. To update by hand at any time:
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
- **Builders:** by default (`auto`) a repository's own `Dockerfile` wins. Without one, the runner detects the stack and builds a generated `Dockerfile.syncbay` (see *Supported stacks*), and only falls back to Nixpacks, then a native process, when nothing is recognised. A failed template build is not retried with Nixpacks; its error names the generated file. `RUNNER_BUILDER` (`auto` | `template` | `nixpacks` | `dockerfile`) in `.env` changes the default for the host; a service variable `SYNCBAY_BUILDER` overrides it per service.
- **Builds behind a proxy:** `HTTP(S)_PROXY` / `NO_PROXY` from `.env` reach `docker build` as build args (by name only, so values never appear in logs). `RUNNER_BUILD_NETWORK=host` lets build steps reach a proxy on the host's `127.0.0.1`. `RUNNER_BUILD_CA_FILE` (a PEM file mounted into the runner container) is trusted by every template build step: npm, pip, Go, Cargo, Composer, Maven/Gradle (imported into the JDK store), Bundler and Deno.
- **Behind NAT instead** (a home machine, or a host with no public IP): keep Cloudflare Tunnel (`TUNNEL_DRIVER=cloudflare` with `CLOUDFLARE_TUNNEL_TOKEN`) and drop the caddy service. Use the tunnel hostname as `RUNNER_URL`.

## Supported stacks
Without a Dockerfile, the runner reads the repository's manifests and generates `Dockerfile.syncbay` (plus `Dockerfile.syncbay.dockerignore`; a repo's `.dockerignore` is reused). Every image listens on `$PORT` on `0.0.0.0`; a service with no port set uses the stack's port below. The service's build and start commands replace the defaults. The deploy log names the detected stack and prints hints (for example Django's `ALLOWED_HOSTS`). "e2e" marks stacks built, started and answered HTTP 200 in `cd runner && npm run test:stacks` (real Docker).

| Stack | Detected from | Image | Default start | Port | e2e |
| --- | --- | --- | --- | --- | --- |
| Node.js: Express, Fastify, Koa, Hono, NestJS … | `package.json` (npm, pnpm, Yarn 1/Berry lockfiles) | `node:<.nvmrc / engines, default 22>-bookworm-slim` | `start` script, `main`, or `server.js` / `index.js` | 3000 | Express |
| Next.js / Nuxt / Remix / SvelteKit (adapter-node) / Astro SSR / Angular SSR | `next`, `nuxt`, `@remix-run/*`, `@sveltejs/kit`, `@astrojs/node`, `@angular/ssr` | same | `next start`, `node .output/server/index.mjs`, `node build` … | 3000 (Astro 4321, Angular SSR 4000) | Next.js |
| Static SPA: Vite (React, Vue, Svelte, Solid), CRA, Vue CLI, Angular, Gatsby, Astro, Next `output: 'export'`, Nuxt generate, SvelteKit adapter-static | build script + output dir (`dist`, `build`, `out`, `dist/<app>/browser` …) | Node build stage → `nginx:1.27-alpine` with SPA fallback to `index.html` | nginx | 8080 | Vite React, Angular 19 |
| Plain static site | `index.html` or `public/index.html` | `nginx:1.27-alpine` | nginx | 8080 | yes |
| Python: Django, FastAPI, Flask, Procfile, `main.py` | `requirements.txt`, `pyproject.toml` (PEP 621), `poetry.lock`, `uv.lock`, `Pipfile`, `manage.py` | `python:<.python-version, default 3.12>-slim` | `gunicorn <project>.wsgi`, `uvicorn main:app`, `gunicorn app:app`, Procfile `web:` | 8000 | Flask, FastAPI, Django |
| Go | `go.mod` (`main.go` or `cmd/<name>/main.go`) | `golang:1.<go.mod>-bookworm` → `debian:bookworm-slim` | the built binary | 8080 | net/http |
| Rust: Axum, Actix Web, Rocket, std | `Cargo.toml` (`[[bin]]` or package name) | `rust:1-bookworm` → `debian:bookworm-slim` | the release binary | 8080 | std `TcpListener` |
| PHP, Laravel | `composer.json`, `index.php`, `public/index.php`, `artisan` | `composer:2` stage → `php:8.3-apache` (doc root `public/` when present) | Apache on `$PORT` | 8080 | plain PHP + Composer autoload |
| Java: Spring Boot, any fat jar | `pom.xml`, `build.gradle(.kts)` (wrapper used when present) | `maven:3.9-eclipse-temurin-21` / `gradle:8-jdk21` → `eclipse-temurin:21-jre` | `java -jar app.jar` | 8080 | — |
| Ruby: Rails, Rack (Sinatra …) | `Gemfile` + `config.ru` / `bin/rails` | `ruby:<.ruby-version, default 3.3>` → `-slim` | `rails server`, `puma`, `rackup` | 3000 | — |
| Deno | `deno.json(c)` | `denoland/deno` | `deno task start` or `main.ts` | 8000 | — |
| Bun | `bun.lock(b)` or `packageManager: bun@…` | `oven/bun:1` | `start` script or `index.ts` | 3000 | — |

- Precedence when a repo has several manifests: Laravel, Rails and Django win over their asset-tooling `package.json`; Go, Java and Rust win over a helper `package.json` (a napi-rs addon stays Node).
- Templates for Django with `psycopg2` (source build), `mysqlclient`, and Rails with `pg`/`mysql2`/`sqlite3` install system libraries with `apt-get`; that needs the Debian mirrors to be reachable from the build.
- Anything not covered: add a `Dockerfile`, or set `SYNCBAY_BUILDER=nixpacks` on the service.
