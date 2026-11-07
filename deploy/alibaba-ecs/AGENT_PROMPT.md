# Prompt: bring the Syncbay runner online (for Antigravity CLI / any coding agent)

Paste everything below the line into `agy`. Run it from a local checkout of `github.com/H410M-H/syncbay` on a machine where `ssh` works, the Vercel CLI is installed (`npm i -g vercel`) and you're logged in (`vercel login`).

---

You are setting up the production data plane for **Syncbay** (repo: H410M-H/syncbay; control plane: https://syncbay.app on Vercel, project `syncbay`, team `msns`).

The goal is to get the runner daemon live at **https://runner.syncbay.app** on an Alibaba Cloud ECS server, then wire the Vercel project to it.

Read these files in this repo first:
- `deploy/alibaba-ecs/README.md`
- `deploy/alibaba-ecs/docker-compose.yml`
- `deploy/alibaba-ecs/setup.sh`
- `.env.example`
- the "Deployment" section of `CLAUDE.md`

## Facts (already done; don't redo)
- **Server:** ECS `i-t4nbgfbh2boggk5bhsz5`, Ubuntu 24.04, 2 vCPU / 4 GiB, Singapore. Public IP **47.237.1.136**. User `root`. The security group allows only 22, 80 and 443.
- **DNS:** Cloudflare has `A runner.syncbay.app → 47.237.1.136`, DNS-only (grey cloud). Don't change it.
- **Database:** production migrations run automatically on every Vercel production build (`scripts/vercel-build.mjs`).

## Hard rules
- **Never print, echo, log or commit a secret value.** That covers passwords, `RUNNER_SECRET`, API keys and tokens. Pipe values straight between commands. When you report back, give variable *names* and whether they're set, never values.
- The initial root password was exposed in a chat. Treat it as compromised. Don't store it anywhere.
- **Existing Vercel env vars:** never overwrite or delete one without asking me first. Check what exists with `vercel env ls production`, which shows names only.
- Ask me for any value you don't have (OAuth secrets, Stripe keys and so on). Don't invent placeholders and push them to Vercel.
- **Stop on failure:** if a step fails, stop and show me the last ~30 lines of output. Don't work around it by disabling TLS, opening extra ports or weakening auth.

## Step 1: secure the server
1. **Make sure I have an SSH key on this machine.** If `~/.ssh/id_ed25519.pub` is missing, create one with `ssh-keygen -t ed25519`.
2. **Install the key:** run `ssh-copy-id root@47.237.1.136`. I'll type the current root password into the interactive prompt myself.
3. **Check key login works:** `ssh -o PasswordAuthentication=no root@47.237.1.136 true`.
4. **Rotate the root password, over SSH:**
   - Generate a new random password locally, without printing it: `openssl rand -base64 24`.
   - Set it with `chpasswd` over SSH.
   - Save it in my OS keychain or password manager if one is available. Otherwise tell me to set my own with `passwd` and skip this.
5. **Disable password logins:**
   - `echo 'PasswordAuthentication no' > /etc/ssh/sshd_config.d/60-syncbay.conf && systemctl restart ssh`.
   - Then confirm that key login still works from a **new** connection before you close the current one.

## Step 2: install and start the runner on the server
Run this over SSH as root:
```bash
cd /opt && (git clone https://github.com/H410M-H/syncbay.git || (cd syncbay && git pull)) && cd /opt/syncbay
bash deploy/alibaba-ecs/setup.sh            # first run: installs Docker + 2G swap, writes deploy/alibaba-ecs/.env with a fresh RUNNER_SECRET, exits
```
Then edit `deploy/alibaba-ecs/.env`. Don't print the file. Use `sed` on these keys only:
- `RUNNER_DOMAIN=runner.syncbay.app`
- `RUNNER_TLS=<ask me for my email>`: the Let's Encrypt account email.
- `RUNNER_DB_HOST=47.237.1.136`
- Leave `RUNNER_SECRET` as generated, and leave `SYNCBAY_API_URL=https://syncbay.app` and `RUNNER_DB_MODE=docker` as they are.

Then:
```bash
bash deploy/alibaba-ecs/setup.sh            # docker compose up -d --build (first build takes several minutes)
docker compose -f deploy/alibaba-ecs/docker-compose.yml ps
curl -fsS https://runner.syncbay.app/health # expect {"status":"ok",...}; Caddy may need ~1 min for the certificate
```

**If the image build fails:**
- `runner/Dockerfile` downloads nixpacks, the Docker CLI and cloudflared for `TARGETARCH`. Fix only what's broken, for example a changed release URL.
- Make the fix in the repo on a new branch and open a PR. Don't hot-patch the server copy.
- Show me the error first.

**If Caddy can't get a certificate:** check `docker compose ... logs caddy`. The likely causes are port 80 not reachable, or DNS not resolving to 47.237.1.136.

## Step 3: Vercel environment variables (Production)
Link the repo with `vercel link --project syncbay --scope msns` if it isn't linked yet. List what's already set with `vercel env ls production`. Then, for each variable below that's **missing**, add it for **Production**. Add it to Preview too where marked.

Use `printf '%s' "$VALUE" | vercel env add NAME production`, so values never appear in shell history or output. If a variable already exists but should change, ask me first. Then use `vercel env rm NAME production --yes` followed by `vercel env add`.

**A. Runner wiring (all required; this is the point of the task)**

| Name | Value |
| --- | --- |
| `RUNNER_URL` | `https://runner.syncbay.app` |
| `RUNNER_DRIVER` | `webhook` |
| `RUNNER_SECRET` | Must equal the value in the server's `.env`. Pipe it straight across with the command below. |

```bash
ssh root@47.237.1.136 "grep '^RUNNER_SECRET=' /opt/syncbay/deploy/alibaba-ecs/.env | cut -d= -f2-" | tr -d '\n' | vercel env add RUNNER_SECRET production
```

**B. Core app (required; probably already set, so only add what's missing and ask me for the values)**
- `DATABASE_URL`, `DIRECT_URL` (direct, non-pooled connection used for migrations). Never overwrite these.
- `NEXTAUTH_URL` = `https://syncbay.app`, `NEXTAUTH_SECRET` (if missing, generate with `openssl rand -base64 32`).
- `NEXT_PUBLIC_APP_URL` = `https://syncbay.app`.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

**C. New secrets (required in production; generate if missing with `openssl rand -hex 32`, piped directly into `vercel env add`)**
- `CRON_SECRET`: protects `/api/cron/tick` and `/api/cron/sweep`. Without it every cron call returns 401.
- `TERMINAL_TOKEN_SECRET`: signs web-terminal sessions. Without it the terminal returns 503.

**D. Cloudflare (recommended; these IDs aren't secret)**
- `CLOUDFLARE_ACCOUNT_ID` = `c678cf5c0fc5ef3806edacc18e6a762d`
- `CLOUDFLARE_ZONE_ID` = `f7d40d6c63c1c11c00aa212c0930242a`
- `CLOUDFLARE_API_TOKEN`: ask me. It needs Zone:DNS:Edit, Zone:Cache Purge and Account:R2:Edit.
- `CLOUDFLARE_CUSTOM_HOSTNAMES` = `off`. The zone has no SSL for SaaS, so custom domains are verified by DNS only.

**E. Optional features: ask me whether to set them now. Skip any I decline.**
- R2 buckets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (from an R2 API token in the Cloudflare dashboard).
- Stripe billing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. The Stripe webhook endpoint is `https://syncbay.app/api/webhooks/stripe`.
- Edge route cache: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- Email: `RESEND_API_KEY`, `EMAIL_FROM`.

**Don't set these** (not used with this setup): `TUNNEL_*`, `CLOUDFLARE_TUNNEL_*`, `RUNNER_SSH_*`, `RUNNER_QUEUE_MODE`, `RUNNER_FORCE_*`, `STRIPE_API_BASE`, `R2_ENDPOINT`, `DATABASE_PARTNER_API_KEY`.

## Step 4: redeploy and verify
1. **Redeploy production** so it picks up the new env. Use `vercel ls syncbay --prod` to find the latest production deployment, then `vercel redeploy <that-url> --target production`.
2. **Watch the build:**
   - The log should show `[vercel-build] prisma migrate status`, then "No pending migrations" or applied migrations, and finally READY.
   - If it stops with **P3005**, stop and show me.
3. **Check the endpoints:**
   - `curl -fsS https://runner.syncbay.app/health` returns status ok.
   - `curl -s -o /dev/null -w '%{http_code}' https://syncbay.app/api/cron/tick` returns `401`, which proves `CRON_SECRET` is enforced.
4. **Real deploy:** ask me to deploy a small service from the Syncbay dashboard. While it runs:
   - Watch `vercel logs --environment production --since 15m` for errors.
   - Run `ssh root@47.237.1.136 'cd /opt/syncbay && docker compose -f deploy/alibaba-ecs/docker-compose.yml logs --tail 50 runner'`.
   - Expect the runner to log `Received POST /api/builds` and the job to succeed.
   - A `401` on the runner means `RUNNER_SECRET` in Vercel doesn't match the server.
5. **Report back:**
   - which Vercel env var names you added, skipped (and why) and left unchanged;
   - the runner health output;
   - the deploy result;
   - anything still open.

   No secret values.
