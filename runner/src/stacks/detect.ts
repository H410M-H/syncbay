/**
 * Stack detection: which language/framework a project uses, read from its manifest files.
 * Pure — it only calls `files.exists()` / `files.read()` / `files.list()`.
 *
 * Order matters when a repository has several manifests: frameworks that ship their own
 * package.json for asset tooling (Laravel, Rails, Django) win over Node, compiled languages win
 * over a helper package.json, and a Node app with a build step is Node or a static SPA — never a
 * plain static site.
 */

import { nodeRangeAllows } from "../launch.ts";
import type { DetectedStack, NodePackageManager, StackFiles, StackPlan } from "./types.ts";

type Pkg = {
  name?: string;
  main?: string;
  packageManager?: string;
  engines?: { node?: unknown };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // JSONC (deno.jsonc, tsconfig-style comments): strip comments and trailing commas.
    try {
      return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1")) as T;
    } catch {
      return null;
    }
  }
}

const first = (files: StackFiles, candidates: string[]): string | undefined => candidates.find((c) => files.exists(c));

// ─── NODE ────────────────────────────────────────────────────────────────────

/** Node.js majors published as `node:<major>-bookworm-slim`. */
const NODE_MAJORS = ["18", "20", "22", "24"];
const DEFAULT_NODE = "22";

/** The Node.js major for the image: `.nvmrc` / `.node-version`, else `engines.node`, else 22. */
export function nodeMajorFor(files: StackFiles, pkg: Pkg | null): string {
  for (const f of [".nvmrc", ".node-version"]) {
    const m = /^v?(\d+)/.exec((files.read(f) || "").trim());
    if (m) return NODE_MAJORS.includes(m[1]) ? m[1] : DEFAULT_NODE;
  }
  const range = pkg?.engines?.node;
  if (typeof range === "string" && range.trim() && !nodeRangeAllows(range, Number(DEFAULT_NODE))) {
    const allowed = [...NODE_MAJORS].reverse().find((major) => nodeRangeAllows(range, Number(major)));
    if (allowed) return allowed;
  }
  return DEFAULT_NODE;
}

function packageManagerFor(files: StackFiles, pkg: Pkg | null): { pm: NodePackageManager; pnpmVersion?: string } {
  const declared = (pkg?.packageManager || "").trim();
  if (files.exists("bun.lockb") || files.exists("bun.lock") || declared.startsWith("bun@")) return { pm: "bun" };
  if (files.exists("pnpm-lock.yaml") || declared.startsWith("pnpm@")) {
    const fromField = /^pnpm@(\d+[\w.+-]*)/.exec(declared)?.[1];
    if (fromField) return { pm: "pnpm", pnpmVersion: fromField.split("+")[0] };
    const lock = /lockfileVersion:\s*'?(\d+)/.exec(files.read("pnpm-lock.yaml") || "")?.[1];
    return { pm: "pnpm", pnpmVersion: lock === "9" ? "10" : lock === "6" ? "8" : lock === "5" ? "7" : "10" };
  }
  if (files.exists("yarn.lock") || declared.startsWith("yarn@")) {
    const berry = files.exists(".yarnrc.yml") || /^yarn@([2-9]|\d{2,})/.test(declared);
    return { pm: berry ? "yarn-berry" : "yarn" };
  }
  return { pm: "npm" };
}

/** `npm run build` for the detected package manager. */
export function runScript(pm: NodePackageManager, script: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm run ${script}`;
    case "yarn":
    case "yarn-berry":
      return `yarn run ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

const SERVER_DEPS = ["express", "fastify", "koa", "@hapi/hapi", "hono", "@nestjs/core", "restify", "polka", "@adonisjs/core", "socket.io", "@trpc/server", "@feathersjs/feathers", "sails"];

function angularOutput(files: StackFiles): { dir: string; ssr: boolean; project?: string } {
  const ng = parseJson<{ defaultProject?: string; projects?: Record<string, any> }>(files.read("angular.json"));
  const projects = ng?.projects || {};
  const name = ng?.defaultProject && projects[ng.defaultProject] ? ng.defaultProject : Object.keys(projects).find((k) => projects[k]?.projectType !== "library") || Object.keys(projects)[0];
  const build = name ? projects[name]?.architect?.build || projects[name]?.targets?.build : undefined;
  const builder = String(build?.builder || "");
  const options = build?.options || {};
  const application = /:application$/.test(builder) || builder.startsWith("@angular/build");
  const outputPath = options.outputPath;
  const ssr = Boolean(options.ssr || options.server);
  let base: string;
  let browser = "browser";
  if (outputPath && typeof outputPath === "object") {
    base = String(outputPath.base || `dist/${name}`);
    if (typeof outputPath.browser === "string") browser = outputPath.browser;
  } else {
    base = typeof outputPath === "string" && outputPath ? outputPath : `dist/${name || "app"}`;
  }
  base = base.replace(/\/+$/, "");
  const dir = application ? (browser ? `${base}/${browser}` : base) : base;
  return { dir, ssr: ssr && application, project: name };
}

function viteOutDir(files: StackFiles): string {
  const config = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts", "vite.config.cjs"].map((f) => files.read(f)).find(Boolean) || "";
  return /outDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(config)?.[1] || "dist";
}

function detectNode(files: StackFiles, pkg: Pkg): DetectedStack {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (d: string) => d in deps;
  const scripts = pkg.scripts || {};
  const { pm, pnpmVersion } = packageManagerFor(files, pkg);
  const notes: string[] = [];
  const installNeedsSource = Boolean(scripts.postinstall || scripts.preinstall || scripts.install || scripts.prepare) || pm === "yarn-berry" || files.exists("pnpm-workspace.yaml") || Array.isArray((pkg as any).workspaces);
  const plan: StackPlan = { packageManager: pm, pnpmVersion, nodeMajor: nodeMajorFor(files, pkg), installNeedsSource };
  const build = scripts.build ? runScript(pm, "build") : undefined;
  const serverDep = SERVER_DEPS.find(has);
  const start = (fallback: string) => (scripts.start ? runScript(pm, "start") : fallback);
  const runtime = pm === "bun" ? { id: "bun" as const, label: "Bun" } : { id: "node" as const, label: "Node.js" };
  const node = (framework: string | undefined, reason: string, startCommand: string, port = 3000): DetectedStack => ({
    ...runtime,
    framework,
    reason,
    port,
    startCommand,
    buildCommand: build,
    notes,
    plan,
  });
  const staticSite = (framework: string, reason: string, outputDir: string): DetectedStack => ({
    id: "static",
    label: "Static site",
    framework,
    reason,
    port: 8080,
    buildCommand: build,
    notes,
    plan: { ...plan, needsBuild: true, outputDir, outputCandidates: ["dist", "build", "out", "public"] },
  });

  if (has("next")) {
    const config = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"].map((f) => files.read(f)).find(Boolean) || "";
    if (/output\s*:\s*["']export["']/.test(config)) {
      const distDir = /distDir\s*:\s*["']([^"']+)["']/.exec(config)?.[1];
      return staticSite("Next.js (static export)", "package.json (next) + output: 'export'", distDir || "out");
    }
    return node("Next.js", "package.json (next)", start("npx next start"));
  }
  if (has("nuxt") || has("nuxt3")) {
    if (/nuxt\s+generate/.test(scripts.build || "") || /nuxi\s+generate/.test(scripts.build || "")) return staticSite("Nuxt (generate)", "package.json (nuxt generate)", ".output/public");
    return node("Nuxt", "package.json (nuxt)", "node .output/server/index.mjs");
  }
  if (Object.keys(deps).some((d) => d.startsWith("@remix-run/")) || has("@react-router/serve") || has("@react-router/node")) {
    return node(has("@react-router/serve") ? "React Router" : "Remix", "package.json (remix)", start("npx remix-serve ./build/index.js"));
  }
  if (has("@sveltejs/kit")) {
    if (has("@sveltejs/adapter-static")) {
      const config = files.read("svelte.config.js") || "";
      return staticSite("SvelteKit (static)", "package.json (@sveltejs/adapter-static)", /pages\s*:\s*["']([^"']+)["']/.exec(config)?.[1] || "build");
    }
    if (!has("@sveltejs/adapter-node")) notes.push("SvelteKit needs @sveltejs/adapter-node (or adapter-static) to run on Syncbay; adapter-auto does not produce a Node server.");
    return node("SvelteKit", "package.json (@sveltejs/kit)", "node build");
  }
  if (has("astro")) {
    if (has("@astrojs/node")) return node("Astro (SSR)", "package.json (astro + @astrojs/node)", "node ./dist/server/entry.mjs", 4321);
    return staticSite("Astro", "package.json (astro)", "dist");
  }
  if (has("@angular/core") && files.exists("angular.json")) {
    const out = angularOutput(files);
    if (has("@angular/ssr") && out.ssr) {
      const serverDir = out.dir.replace(/\/browser$/, "/server");
      return node("Angular (SSR)", "angular.json + @angular/ssr", `node ${serverDir}/server.mjs`, 4000);
    }
    return { ...staticSite("Angular", "angular.json", out.dir), buildCommand: build || "npx ng build" };
  }
  if (has("@nestjs/core")) return node("NestJS", "package.json (@nestjs/core)", scripts["start:prod"] ? runScript(pm, "start:prod") : "node dist/main");
  if (!serverDep) {
    if (has("react-scripts")) return staticSite("React (Create React App)", "package.json (react-scripts)", "build");
    if (has("@vue/cli-service")) {
      const config = files.read("vue.config.js") || "";
      return staticSite("Vue CLI", "package.json (@vue/cli-service)", /outputDir\s*:\s*["']([^"']+)["']/.exec(config)?.[1] || "dist");
    }
    if (has("gatsby")) return staticSite("Gatsby", "package.json (gatsby)", "public");
    if (has("vite") && scripts.build && !scripts.start) {
      const flavour = has("react") ? "React (Vite)" : has("vue") ? "Vue (Vite)" : has("svelte") ? "Svelte (Vite)" : has("solid-js") ? "Solid (Vite)" : has("preact") ? "Preact (Vite)" : "Vite";
      return staticSite(flavour, "package.json (vite)", viteOutDir(files));
    }
  }

  const framework = serverDep ? { express: "Express", fastify: "Fastify", koa: "Koa", "@hapi/hapi": "hapi", hono: "Hono" }[serverDep as string] : undefined;
  let startCommand = scripts.start ? runScript(pm, "start") : undefined;
  const nodeBin = pm === "bun" ? "bun" : "node";
  if (!startCommand && pkg.main && files.exists(pkg.main)) startCommand = `${nodeBin} ${pkg.main}`;
  if (!startCommand) {
    const entry = first(files, ["server.js", "server.mjs", "server.cjs", "index.js", "index.mjs", "app.js", "main.js", "src/server.js", "src/index.js", "src/app.js", "dist/server.js", "dist/index.js", ...(pm === "bun" ? ["index.ts", "server.ts", "src/index.ts", "src/server.ts"] : [])]);
    if (entry) startCommand = `${nodeBin} ${entry}`;
  }
  if (!startCommand) {
    if (files.exists("index.html") && !scripts.build) {
      return { id: "static", label: "Static site", reason: "index.html (package.json has no build or start script)", port: 8080, notes, plan: { outputDir: ".", needsBuild: false } };
    }
    notes.push("No start script found; add \"start\" to package.json or set a start command.");
    startCommand = runScript(pm, "start");
  }
  return node(framework, serverDep ? `package.json (${serverDep})` : "package.json", startCommand);
}

// ─── PYTHON ──────────────────────────────────────────────────────────────────

const PY_ENTRY_FILES = ["main.py", "app.py", "app/main.py", "app/__init__.py", "src/main.py", "src/app.py", "server.py", "api.py", "wsgi.py", "asgi.py", "application.py", "run.py"];

function pythonDepsText(files: StackFiles): string {
  return ["requirements.txt", "requirements/base.txt", "requirements/prod.txt", "requirements/production.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg"]
    .map((f) => files.read(f) || "")
    .join("\n")
    .toLowerCase();
}

/** `[project].dependencies` of a pyproject.toml (PEP 621), as written. */
export function pyprojectDependencies(toml: string): string[] {
  const section = /^\[project\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml)?.[1] || "";
  const block = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(section)?.[1];
  if (!block) return [];
  return [...block.matchAll(/["']([^"']+)["']/g)].map((m) => m[1].trim()).filter(Boolean);
}

/** `module:variable` of the app object (`app = FastAPI()` / `app = Flask(__name__)` / `create_app()` factory). */
function findPythonApp(files: StackFiles, ctor: "FastAPI" | "Flask"): string | null {
  for (const file of PY_ENTRY_FILES) {
    const src = files.read(file);
    if (!src) continue;
    const pyModule = file.replace(/\/__init__\.py$/, "").replace(/\.py$/, "").replace(/\//g, ".");
    const variable = new RegExp(`^([A-Za-z_]\\w*)\\s*(?::\\s*\\w+\\s*)?=\\s*${ctor}\\(`, "m").exec(src)?.[1];
    if (variable) return `${pyModule}:${variable}`;
    if (ctor === "Flask" && /^def\s+create_app\s*\(/m.test(src)) return `${pyModule}:create_app()`;
  }
  return null;
}

function pythonVersion(files: StackFiles): string {
  const raw = (files.read(".python-version") || files.read("runtime.txt") || "").trim();
  const m = /(?:python-)?3\.(\d+)/.exec(raw);
  const minor = m ? Number(m[1]) : 12;
  return `3.${minor >= 9 && minor <= 13 ? minor : 12}`;
}

function procfileWeb(files: StackFiles): string | null {
  const line = (files.read("Procfile") || "").split(/\r?\n/).find((l) => /^web\s*:/.test(l));
  return line ? line.replace(/^web\s*:\s*/, "").trim() || null : null;
}

function hasPythonManifest(files: StackFiles): boolean {
  return ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "uv.lock", "poetry.lock", "manage.py"].some((f) => files.exists(f));
}

function detectPython(files: StackFiles): DetectedStack {
  const deps = pythonDepsText(files);
  const dep = (name: string) => new RegExp(`(^|[\\s"'\\[,])${name}(\\s|[<>=~!;\\[,"']|$)`, "m").test(deps);
  const pyproject = files.read("pyproject.toml") || "";
  const plan: StackPlan = { pythonVersion: pythonVersion(files), pythonExtras: [] };
  let reason: string;
  if (files.exists("uv.lock")) {
    plan.pythonInstall = "uv";
    reason = "uv.lock";
  } else if (files.exists("poetry.lock") || /^\[tool\.poetry\]/m.test(pyproject)) {
    plan.pythonInstall = "poetry";
    reason = files.exists("poetry.lock") ? "poetry.lock" : "pyproject.toml (poetry)";
  } else if (files.exists("requirements.txt")) {
    plan.pythonInstall = "requirements";
    // `-r other.txt`, `-e .` or a local path need more than requirements.txt in the install layer.
    plan.installNeedsSource = /^\s*(-r|--requirement|-c|--constraint|-e|--editable|\.|\/)/m.test(files.read("requirements.txt") || "");
    reason = "requirements.txt";
  } else if (files.exists("Pipfile")) {
    plan.pythonInstall = "pipenv";
    reason = "Pipfile";
  } else if (pyproject) {
    plan.pythonInstall = "pyproject";
    plan.pythonDeps = pyprojectDependencies(pyproject);
    reason = "pyproject.toml";
  } else {
    plan.pythonInstall = "none";
    reason = files.exists("manage.py") ? "manage.py" : "Procfile";
  }
  const apt: string[] = [];
  if (/(^|[\s"'])psycopg2(\s|[<>=~!;\[,"']|$)/m.test(deps)) apt.push("gcc", "libpq-dev");
  if (dep("mysqlclient")) apt.push("gcc", "default-libmysqlclient-dev", "pkg-config");
  if (apt.length) plan.aptPackages = [...new Set(apt)];
  const notes: string[] = [];
  const procfile = procfileWeb(files);
  const needs = (pkgName: string) => {
    if (!dep(pkgName)) plan.pythonExtras!.push(pkgName);
  };

  if (files.exists("manage.py") || dep("django")) {
    const settings = /DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/.exec(files.read("manage.py") || "")?.[1];
    const project = settings ? settings.replace(/\.settings(\..*)?$/, "") : undefined;
    plan.djangoProject = project;
    if (!procfile) needs("gunicorn");
    notes.push("Django: set ALLOWED_HOSTS (and CSRF_TRUSTED_ORIGINS) to include the service's hostname, and STATIC_ROOT for collectstatic.");
    return {
      id: "python",
      label: "Python",
      framework: "Django",
      reason: files.exists("manage.py") ? `manage.py + ${reason}` : reason,
      port: 8000,
      startCommand: procfile || (project ? `gunicorn ${project}.wsgi:application --bind 0.0.0.0:$PORT` : undefined),
      notes,
      plan,
    };
  }
  if (dep("fastapi")) {
    const target = findPythonApp(files, "FastAPI") || "main:app";
    if (!procfile) needs("uvicorn");
    return { id: "python", label: "Python", framework: "FastAPI", reason, port: 8000, startCommand: procfile || `uvicorn ${target} --host 0.0.0.0 --port $PORT`, notes, plan };
  }
  if (dep("flask")) {
    const target = findPythonApp(files, "Flask") || "app:app";
    if (!procfile) needs("gunicorn");
    return { id: "python", label: "Python", framework: "Flask", reason, port: 8000, startCommand: procfile || `gunicorn --bind 0.0.0.0:$PORT ${shellSafe(target)}`, notes, plan };
  }
  const entry = first(files, ["main.py", "app.py", "server.py", "run.py"]);
  if (!procfile && !entry) notes.push("No Procfile web process or main.py/app.py found; set a start command.");
  return {
    id: "python",
    label: "Python",
    framework: procfile ? "Procfile" : undefined,
    reason: procfile && reason !== "Procfile" ? `${reason} + Procfile` : reason,
    port: 8000,
    startCommand: procfile || (entry ? `python ${entry}` : undefined),
    notes,
    plan,
  };
}

/** Quotes a gunicorn target that contains shell syntax (`module:create_app()`). */
const shellSafe = (target: string) => (/^[\w.:]+$/.test(target) ? target : `'${target}'`);

// ─── OTHER LANGUAGES ─────────────────────────────────────────────────────────

function detectGo(files: StackFiles): DetectedStack {
  const mod = files.read("go.mod") || "";
  const goModule = /^module\s+(\S+)/m.exec(mod)?.[1] || "";
  const minor = Number(/^go\s+1\.(\d+)/m.exec(mod)?.[1] || 23);
  const goVersion = `1.${Math.min(Math.max(minor, 21), 25)}`;
  let goPackage = ".";
  if (!files.exists("main.go")) {
    const last = goModule.split("/").pop() || "";
    const listed = files.list?.("cmd") || [];
    const cmd = [last, "server", "api", "app", "web", ...listed].filter(Boolean).find((c) => files.exists(`cmd/${c}/main.go`));
    if (cmd) goPackage = `./cmd/${cmd}`;
  }
  const cgo = /github\.com\/mattn\/go-sqlite3/.test(mod);
  return { id: "go", label: "Go", reason: "go.mod", port: 8080, startCommand: "/usr/local/bin/app", notes: [], plan: { goVersion, goPackage, cgo } };
}

/** Binary name of a Cargo package: the first `[[bin]]` name, else `[package].name`. */
export function cargoBinName(toml: string): string | null {
  const bin = /^\[\[bin\]\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml)?.[1];
  const binName = bin ? /^name\s*=\s*["']([^"']+)["']/m.exec(bin)?.[1] : undefined;
  if (binName) return binName;
  const pkg = /^\[package\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml)?.[1];
  return pkg ? /^name\s*=\s*["']([^"']+)["']/m.exec(pkg)?.[1] || null : null;
}

function detectRust(files: StackFiles): DetectedStack {
  const toml = files.read("Cargo.toml") || "";
  const binName = cargoBinName(toml) || undefined;
  const notes = binName ? [] : ["Cargo.toml has no [package] or [[bin]] name; the first executable in target/release is used."];
  const framework = /^\s*axum\s*=/m.test(toml) ? "Axum" : /^\s*actix-web\s*=/m.test(toml) ? "Actix Web" : /^\s*rocket\s*=/m.test(toml) ? "Rocket" : undefined;
  return { id: "rust", label: "Rust", framework, reason: "Cargo.toml", port: 8080, startCommand: "/usr/local/bin/app", notes, plan: { binName } };
}

function detectPhp(files: StackFiles): DetectedStack {
  const laravel = files.exists("artisan") && files.exists("composer.json");
  const docRoot = laravel || files.exists("public/index.php") || (!files.exists("index.php") && files.exists("public/index.html")) ? "public" : ".";
  const notes = laravel ? ["Laravel: set APP_KEY (php artisan key:generate --show) and APP_URL; run migrations from a release command."] : [];
  return {
    id: "php",
    label: "PHP",
    framework: laravel ? "Laravel" : undefined,
    reason: laravel ? "artisan + composer.json" : files.exists("composer.json") ? "composer.json" : docRoot === "public" ? "public/index.php" : "index.php",
    port: 8080,
    startCommand: "apache2-foreground",
    notes,
    plan: { laravel, docRoot, composer: files.exists("composer.json") },
  };
}

function detectJava(files: StackFiles): DetectedStack {
  const maven = files.exists("pom.xml");
  const buildFile = maven ? files.read("pom.xml") || "" : files.read("build.gradle.kts") || files.read("build.gradle") || "";
  const spring = /spring-boot/.test(buildFile);
  return {
    id: "java",
    label: "Java",
    framework: spring ? "Spring Boot" : undefined,
    reason: maven ? "pom.xml" : files.exists("build.gradle.kts") ? "build.gradle.kts" : "build.gradle",
    port: 8080,
    startCommand: "java -Dserver.port=$PORT -jar /app/app.jar",
    notes: spring ? [] : ["The build must produce a runnable (fat) jar; set a start command otherwise."],
    plan: { javaTool: maven ? "maven" : "gradle", wrapper: maven ? files.exists("mvnw") : files.exists("gradlew") },
  };
}

function detectRuby(files: StackFiles): DetectedStack {
  const gemfile = `${files.read("Gemfile") || ""}\n${files.read("Gemfile.lock") || ""}`;
  const rails = files.exists("bin/rails") || files.exists("config/application.rb") || /^\s*gem\s+["']rails["']/m.test(gemfile);
  const version = /(\d+)\.(\d+)/.exec((files.read(".ruby-version") || "").trim());
  const minor = version && version[1] === "3" ? Number(version[2]) : 3;
  const rubyVersion = `3.${minor >= 1 && minor <= 4 ? minor : 3}`;
  const puma = /\bpuma\b/.test(gemfile);
  const startCommand = rails
    ? "bundle exec rails server -b 0.0.0.0 -p $PORT"
    : puma
      ? "bundle exec puma -b tcp://0.0.0.0:$PORT config.ru"
      : "bundle exec rackup -o 0.0.0.0 -p $PORT";
  const apt: string[] = [];
  if (/\bpg\b/.test(gemfile)) apt.push("libpq5");
  if (/\bmysql2\b/.test(gemfile)) apt.push("libmariadb3");
  if (/\bsqlite3\b/.test(gemfile)) apt.push("libsqlite3-0");
  return {
    id: "ruby",
    label: "Ruby",
    framework: rails ? "Rails" : "Rack",
    reason: rails ? "Gemfile + Rails" : "Gemfile + config.ru",
    port: 3000,
    startCommand,
    notes: rails ? ["Rails: set SECRET_KEY_BASE (or RAILS_MASTER_KEY) and run migrations from a release command."] : [],
    plan: { rubyVersion, rails, aptPackages: apt.length ? apt : undefined },
  };
}

function detectDeno(files: StackFiles): DetectedStack {
  const config = parseJson<{ tasks?: Record<string, string> }>(files.read("deno.json") || files.read("deno.jsonc"));
  const entry = first(files, ["main.ts", "server.ts", "mod.ts", "src/main.ts", "main.js", "server.js"]);
  const startCommand = config?.tasks?.start ? "deno task start" : entry ? `deno run --allow-net --allow-env --allow-read ${entry}` : undefined;
  return {
    id: "deno",
    label: "Deno",
    reason: files.exists("deno.json") ? "deno.json" : "deno.jsonc",
    port: 8000,
    startCommand,
    notes: startCommand ? [] : ["Add a \"start\" task to deno.json or a main.ts."],
    plan: { denoEntry: entry },
  };
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

/** Detects the project's stack, or null when nothing is recognised (Nixpacks / native fallback). */
export function detectStack(files: StackFiles): DetectedStack | null {
  const pkgText = files.read("package.json");
  const pkg = pkgText ? parseJson<Pkg>(pkgText) || {} : null;
  const pkgDeps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};

  if ((files.exists("deno.json") || files.exists("deno.jsonc")) && !pkg) return detectDeno(files);
  if (files.exists("artisan") && files.exists("composer.json")) return detectPhp(files);
  if (files.exists("Gemfile") && (files.exists("config.ru") || files.exists("bin/rails") || files.exists("config/application.rb"))) return detectRuby(files);
  if (hasPythonManifest(files)) {
    const deps = pythonDepsText(files);
    const webFramework = files.exists("manage.py") || /(^|[\s"'\[,])(django|flask|fastapi)(\s|[<>=~!;\[,"']|$)/m.test(deps);
    if (!pkg || webFramework) return detectPython(files);
  }
  if (files.exists("go.mod")) return detectGo(files);
  if (files.exists("pom.xml") || files.exists("build.gradle") || files.exists("build.gradle.kts")) return detectJava(files);
  if (files.exists("Cargo.toml") && !("@napi-rs/cli" in pkgDeps || "neon-cli" in pkgDeps || "@neon-rs/cli" in pkgDeps)) return detectRust(files);
  if (pkg) return detectNode(files, pkg);
  if (files.exists("composer.json") || files.exists("index.php") || files.exists("public/index.php")) return detectPhp(files);
  if (files.exists("Gemfile")) return detectRuby(files);
  const procfile = procfileWeb(files);
  if (procfile && /\b(python|gunicorn|uvicorn|hypercorn|daphne|waitress)\b/.test(procfile)) return detectPython(files);
  if (files.exists("index.html")) return { id: "static", label: "Static site", reason: "index.html", port: 8080, notes: [], plan: { outputDir: ".", needsBuild: false } };
  if (files.exists("public/index.html")) return { id: "static", label: "Static site", reason: "public/index.html", port: 8080, notes: [], plan: { outputDir: "public", needsBuild: false } };
  return null;
}
