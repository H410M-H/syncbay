/** Landing-page FAQ, shared by the visible FAQ section and the FAQPage JSON-LD in the root layout. */

export interface FAQItem {
  question: string;
  answer: string;
  category: string;
}

export const FAQS: FAQItem[] = [
  {
    category: "Architecture",
    question: "Where do my apps actually run?",
    answer:
      "Syncbay is a hybrid PaaS. The control plane (dashboard, API, scheduling) runs on Vercel; your apps, builds and managed databases run on Syncbay runner hosts — Linux servers running the Syncbay runner daemon — behind Cloudflare. Today there is one runner region. You can also connect your own server by running the runner daemon on it.",
  },
  {
    category: "Builds & Runtimes",
    question: "Do I need to write a Dockerfile to deploy?",
    answer:
      "No. If your repo has a Dockerfile, Syncbay uses it. Otherwise the runner detects your stack and generates a Dockerfile for Node (Express, Nest, Next.js, Nuxt, Remix, SvelteKit, Astro), static SPAs (Angular, React/Vite, Vue, Svelte, plain HTML), Python (Flask, FastAPI, Django), Go, Rust, PHP/Laravel, Java, Ruby, Deno or Bun, and falls back to Nixpacks. Your own files are never overwritten.",
  },
  {
    category: "Cold Starts",
    question: "Are there cold starts?",
    answer:
      "Not for always-on services, which is the default: they keep running between requests. If you turn on scale-to-zero for a service, it sleeps after its idle timeout; visitors then see a Syncbay start-up page until a workspace member wakes it from that page or redeploys, and the service needs time to start again.",
  },
  {
    category: "Databases",
    question: "How do managed PostgreSQL, Redis and MySQL work?",
    answer:
      "Create a database from the dashboard and Syncbay provisions it on the runner: PostgreSQL (optionally with pgvector), Redis or Valkey, or MySQL. DATABASE_URL or REDIS_URL is added to your services and merged in at deploy time without overriding variables you set. You can test the connection and browse tables in the Data view, and run queries in Query Studio, which is read-only by default.",
  },
  {
    category: "Production Reliability",
    question: "How do zero-downtime releases and rollbacks work?",
    answer:
      "A new deployment builds and starts while the current one keeps serving. Traffic moves only after the new instance answers its health check (/health, then /); a new instance has up to 120 seconds to become healthy. If the build or the check fails, the live version stays up. You can roll back to an earlier build, restart or pause a service from the console, and the health monitor restarts an instance after two failed probes in a row.",
  },
  {
    category: "Domains & Billing",
    question: "Custom domains, TLS and pricing?",
    answer:
      "Every service gets a <service>-<env>.syncbay.app host. Add your own domain, create the DNS records Syncbay shows you, and it is verified and served with TLS through Cloudflare. Billing is usage-based with no per-seat fees — see the pricing page for the rate card — and you can set a monthly spending cap that pauses services when it is reached.",
  },
];
