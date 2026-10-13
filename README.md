# Syncbay — Cloud Application Platform

> A Railway-class PaaS built on Next.js 15, tRPC, Prisma, and Cloudflare Containers.
> PRD v0.1 | MSNS-DEV™ | September 2026

## Tech Stack

| Layer | Technology |
|---|---|
| **Control Plane** | Next.js 16 App Router · TypeScript strict |
| **API** | tRPC v11 · React Query v5 · superjson |
| **Auth** | NextAuth.js v5 · GitHub OAuth · email/password |
| **ORM / DB** | Prisma · PostgreSQL |
| **Data Plane** | Cloudflare Containers (Phase 1+) |
| **Billing** | Stripe (Phase 2) |
| **Email** | Resend |
| **Hosting** | Vercel Pro (control plane) · Cloudflare (edge + data plane) |

## Project Structure

```
syncbay/
├── prisma/
│   └── schema.prisma          ← Full control-plane schema (§6 of PRD)
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── trpc/[trpc]/   ← tRPC fetch handler
│   │   │   └── auth/[...]/    ← NextAuth route
│   │   ├── auth/signin/       ← Sign-in page
│   │   └── dashboard/         ← Protected dashboard shell
│   ├── server/
│   │   ├── trpc.ts            ← tRPC init, context, middleware
│   │   ├── root.ts            ← Root router
│   │   └── routers/
│   │       ├── workspace.ts
│   │       ├── project.ts
│   │       ├── service.ts
│   │       └── deployment.ts
│   └── lib/
│       ├── db.ts              ← Prisma singleton
│       └── auth.ts            ← NextAuth config
└── .env.example               ← All required env vars documented
```

## Getting Started

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env.local
# Fill in DATABASE_URL, NEXTAUTH_SECRET, GITHUB_CLIENT_ID/SECRET
```

### 3. Generate a secret
```bash
openssl rand -base64 32  # paste as NEXTAUTH_SECRET
```

### 4. Run database migrations
```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 5. Start dev server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Phase Roadmap

| Phase | Theme | Status |
|---|---|---|
| **Phase 0** | Control-plane skeleton (auth, schema, tRPC, UI shell) | ✅ Complete |
| **Phase 1** | MVP Deploy Loop (GitHub → build → deploy → domain → logs sync & management) | ✅ Complete (`a8b4562`) |
| **Phase 2** | Team & Confidence (custom domains, metrics, billing) | 🚀 In Progress |
| **Phase 3** | Platform Depth (private net, volumes, feature flags) | Planned |
| **Phase 4** | Ecosystem (CLI, public API, AI agent, templates) | Planned |

See [`Syncbay365.md`](../storage/shared/Syncbay365.md) for the full PRD.

---

*Syncbay PRD v0.1 · MSNS-DEV™ · September 2026 · DRAFT*
