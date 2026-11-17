/**
 * Stack templates: detection fixtures, generated Dockerfile content, builder selection and the
 * pipeline's choice of strategy (mock executor). Real builds: test/stacks-e2e.test.ts.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PortManager } from "../src/port-manager.ts";
import { BuildPipeline, MockPipelineExecutor, builderPreference, dockerBuildFlags, hostEnvForApps, readRepoFile, stackFilesFor, writeOwnFile } from "../src/pipeline.ts";
import { cargoBinName, detectStack, generateDockerfile, generateDockerignore, pyprojectDependencies, type DetectedStack, type StackFiles } from "../src/stacks/index.ts";

/** In-memory project: relative path → content. Directories exist when a file lies below them. */
function mem(files: Record<string, string>): StackFiles {
  const keys = Object.keys(files);
  return {
    exists: (rel) => rel in files || keys.some((k) => k.startsWith(`${rel}/`)),
    read: (rel) => (rel in files ? files[rel] : null),
    list: (rel) => [...new Set(keys.filter((k) => k.startsWith(`${rel}/`)).map((k) => k.slice(rel.length + 1).split("/")[0]))],
  };
}

const json = (value: unknown) => JSON.stringify(value);
const pkg = (body: Record<string, unknown>) => json({ name: "app", version: "1.0.0", ...body });
const detect = (files: Record<string, string>) => {
  const stack = detectStack(mem(files));
  assert.ok(stack, `a stack is detected for ${Object.keys(files).join(", ")}`);
  return stack!;
};
const dockerfile = (stack: DetectedStack, extra: Partial<Parameters<typeof generateDockerfile>[1]> = {}) => generateDockerfile(stack, { port: stack.port, ...extra });

// ─── DETECTION FIXTURES ──────────────────────────────────────────────────────

const FIXTURES: Array<{ name: string; files: Record<string, string>; expect: Partial<DetectedStack> & { plan?: Record<string, unknown> } }> = [
  {
    name: "express",
    files: { "package.json": pkg({ scripts: { start: "node server.js" }, dependencies: { express: "^4" } }), "package-lock.json": "{}", "server.js": "" },
    expect: { id: "node", framework: "Express", port: 3000, startCommand: "npm run start", plan: { packageManager: "npm" } },
  },
  {
    name: "next",
    files: { "package.json": pkg({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15", react: "19" } }) },
    expect: { id: "node", framework: "Next.js", buildCommand: "npm run build", startCommand: "npm run start" },
  },
  {
    name: "next static export",
    files: { "package.json": pkg({ scripts: { build: "next build" }, dependencies: { next: "15" } }), "next.config.mjs": "export default { output: 'export' };" },
    expect: { id: "static", framework: "Next.js (static export)", plan: { outputDir: "out", needsBuild: true } },
  },
  {
    name: "nuxt",
    files: { "package.json": pkg({ scripts: { build: "nuxt build" }, dependencies: { nuxt: "^3" } }) },
    expect: { id: "node", framework: "Nuxt", startCommand: "node .output/server/index.mjs" },
  },
  {
    name: "sveltekit with adapter-node",
    files: { "package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { "@sveltejs/kit": "^2", "@sveltejs/adapter-node": "^5", vite: "^5" } }) },
    expect: { id: "node", framework: "SvelteKit", startCommand: "node build", notes: [] },
  },
  {
    name: "nestjs",
    files: { "package.json": pkg({ scripts: { build: "nest build", "start:prod": "node dist/main" }, dependencies: { "@nestjs/core": "^10" } }), "yarn.lock": "" },
    expect: { id: "node", framework: "NestJS", startCommand: "yarn run start:prod", plan: { packageManager: "yarn" } },
  },
  {
    name: "vite react spa",
    files: { "package.json": pkg({ scripts: { dev: "vite", build: "vite build" }, dependencies: { react: "18" }, devDependencies: { vite: "5" } }), "index.html": "<div id=root>" },
    expect: { id: "static", framework: "React (Vite)", plan: { outputDir: "dist", needsBuild: true } },
  },
  {
    name: "create react app",
    files: { "package.json": pkg({ scripts: { start: "react-scripts start", build: "react-scripts build" }, dependencies: { "react-scripts": "5", react: "18" } }) },
    expect: { id: "static", framework: "React (Create React App)", plan: { outputDir: "build" } },
  },
  {
    name: "angular 17+ (application builder → /browser)",
    files: {
      "package.json": pkg({ scripts: { build: "ng build" }, dependencies: { "@angular/core": "^19" } }),
      "angular.json": json({ projects: { shop: { projectType: "application", architect: { build: { builder: "@angular/build:application", options: { outputPath: "dist/shop" } } } } } }),
    },
    expect: { id: "static", framework: "Angular", plan: { outputDir: "dist/shop/browser" } },
  },
  {
    name: "angular legacy browser builder",
    files: {
      "package.json": pkg({ dependencies: { "@angular/core": "^15" } }),
      "angular.json": json({ defaultProject: "legacy", projects: { legacy: { architect: { build: { builder: "@angular-devkit/build-angular:browser", options: { outputPath: "dist/legacy" } } } } } }),
    },
    expect: { id: "static", framework: "Angular", buildCommand: "npx ng build", plan: { outputDir: "dist/legacy" } },
  },
  {
    name: "vue cli",
    files: { "package.json": pkg({ scripts: { build: "vue-cli-service build" }, devDependencies: { "@vue/cli-service": "5" } }), "vue.config.js": "module.exports = { outputDir: 'public-build' }" },
    expect: { id: "static", framework: "Vue CLI", plan: { outputDir: "public-build" } },
  },
  {
    name: "plain html",
    files: { "index.html": "<h1>hi</h1>", "style.css": "" },
    expect: { id: "static", port: 8080, plan: { outputDir: ".", needsBuild: false } },
  },
  {
    name: "public/index.html",
    files: { "public/index.html": "<h1>hi</h1>" },
    expect: { id: "static", plan: { outputDir: "public", needsBuild: false } },
  },
  {
    name: "flask",
    files: { "requirements.txt": "Flask==3.0\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" },
    expect: { id: "python", framework: "Flask", port: 8000, startCommand: "gunicorn --bind 0.0.0.0:$PORT app:app", plan: { pythonInstall: "requirements", pythonExtras: ["gunicorn"] } },
  },
  {
    name: "flask app factory",
    files: { "requirements.txt": "flask\ngunicorn\n", "app/__init__.py": "def create_app():\n    pass\n" },
    expect: { id: "python", framework: "Flask", startCommand: "gunicorn --bind 0.0.0.0:$PORT 'app:create_app()'", plan: { pythonExtras: [] } },
  },
  {
    name: "fastapi",
    files: { "requirements.txt": "fastapi\n", "src/main.py": "from fastapi import FastAPI\napi = FastAPI()\n" },
    expect: { id: "python", framework: "FastAPI", startCommand: "uvicorn src.main:api --host 0.0.0.0 --port $PORT", plan: { pythonExtras: ["uvicorn"] } },
  },
  {
    name: "django",
    files: { "requirements.txt": "Django>=5\npsycopg2-binary\n", "manage.py": "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'shop.settings')" },
    expect: { id: "python", framework: "Django", startCommand: "gunicorn shop.wsgi:application --bind 0.0.0.0:$PORT" },
  },
  {
    name: "poetry",
    files: { "pyproject.toml": "[tool.poetry]\nname = 'x'\n\n[tool.poetry.dependencies]\nfastapi = '*'\n", "poetry.lock": "", ".python-version": "3.11" },
    expect: { id: "python", framework: "FastAPI", plan: { pythonInstall: "poetry", pythonVersion: "3.11" } },
  },
  {
    name: "Procfile python",
    files: { Procfile: "web: hypercorn api:app --bind 0.0.0.0:$PORT\nworker: python worker.py\n", "requirements.txt": "hypercorn\n" },
    expect: { id: "python", framework: "Procfile", startCommand: "hypercorn api:app --bind 0.0.0.0:$PORT" },
  },
  {
    name: "go cmd/ package",
    files: { "go.mod": "module github.com/acme/billing\n\ngo 1.22\n", "cmd/server/main.go": "package main" },
    expect: { id: "go", port: 8080, plan: { goPackage: "./cmd/server", goVersion: "1.22", cgo: false } },
  },
  {
    name: "rust [[bin]]",
    files: { "Cargo.toml": "[package]\nname = \"crate-name\"\n\n[[bin]]\nname = \"api-server\"\npath = \"src/main.rs\"\n\n[dependencies]\naxum = \"0.7\"\n" },
    expect: { id: "rust", framework: "Axum", plan: { binName: "api-server" } },
  },
  {
    name: "laravel",
    files: { artisan: "", "composer.json": json({ require: { "laravel/framework": "^11" } }), "public/index.php": "" },
    expect: { id: "php", framework: "Laravel", plan: { laravel: true, docRoot: "public", composer: true } },
  },
  {
    name: "plain php",
    files: { "index.php": "<?php echo 1;" },
    expect: { id: "php", reason: "index.php", plan: { laravel: false, docRoot: ".", composer: false } },
  },
  {
    name: "maven",
    files: { "pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>", mvnw: "" },
    expect: { id: "java", framework: "Spring Boot", plan: { javaTool: "maven", wrapper: true } },
  },
  {
    name: "gradle kotlin dsl",
    files: { "build.gradle.kts": "plugins { application }" },
    expect: { id: "java", reason: "build.gradle.kts", plan: { javaTool: "gradle", wrapper: false } },
  },
  {
    name: "rails",
    files: { Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'pg'\n", "config/application.rb": "", "bin/rails": "", ".ruby-version": "3.2.2" },
    expect: { id: "ruby", framework: "Rails", startCommand: "bundle exec rails server -b 0.0.0.0 -p $PORT", plan: { rubyVersion: "3.2", rails: true, aptPackages: ["libpq5"] } },
  },
  {
    name: "rack + puma",
    files: { Gemfile: "gem 'sinatra'\ngem 'puma'\n", "config.ru": "run App" },
    expect: { id: "ruby", framework: "Rack", startCommand: "bundle exec puma -b tcp://0.0.0.0:$PORT config.ru" },
  },
  {
    name: "deno",
    files: { "deno.json": `{ // comment\n "tasks": { "start": "deno run -A main.ts" }, }`, "main.ts": "" },
    expect: { id: "deno", port: 8000, startCommand: "deno task start", plan: { denoEntry: "main.ts" } },
  },
  {
    name: "bun",
    files: { "package.json": pkg({ dependencies: { hono: "^4" } }), "bun.lockb": "", "index.ts": "" },
    expect: { id: "bun", framework: "Hono", startCommand: "bun index.ts", plan: { packageManager: "bun" } },
  },
  {
    name: "pnpm lockfile v9",
    files: { "package.json": pkg({ scripts: { start: "node ." }, dependencies: { fastify: "^4" } }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" },
    expect: { id: "node", framework: "Fastify", startCommand: "pnpm run start", plan: { packageManager: "pnpm", pnpmVersion: "10" } },
  },
];

for (const fixture of FIXTURES) {
  test(`stacks: detects ${fixture.name}`, () => {
    const stack = detect(fixture.files);
    const { plan, ...top } = fixture.expect;
    for (const [key, value] of Object.entries(top)) assert.deepStrictEqual((stack as any)[key], value, `${fixture.name}: ${key}`);
    for (const [key, value] of Object.entries(plan || {})) assert.deepStrictEqual((stack.plan as any)[key], value, `${fixture.name}: plan.${key}`);
    // Every detected stack produces a Dockerfile with a FROM line and a port.
    const text = dockerfile(stack);
    assert.match(text, /^FROM \S+/m);
    assert.match(text, new RegExp(`^EXPOSE ${stack.port}$`, "m"));
  });
}

test("stacks: precedence between manifests", () => {
  const laravel = detect({ artisan: "", "composer.json": "{}", "package.json": pkg({ devDependencies: { vite: "5" }, scripts: { build: "vite build" } }) });
  assert.strictEqual(laravel.id, "php", "Laravel with a package.json for assets is PHP");
  const django = detect({ "manage.py": "", "requirements.txt": "django\n", "package.json": pkg({ scripts: { build: "webpack" } }) });
  assert.strictEqual(django.id, "python", "Django with a package.json is Python");
  const napi = detect({ "Cargo.toml": "[package]\nname = \"addon\"\n", "package.json": pkg({ devDependencies: { "@napi-rs/cli": "2" }, scripts: { start: "node index.js" } }) });
  assert.strictEqual(napi.id, "node", "a napi-rs addon is a Node project");
  const tooling = detect({ "requirements.txt": "black\n", "package.json": pkg({ scripts: { start: "node server.js" } }) });
  assert.strictEqual(tooling.id, "node", "Python tooling without a web framework does not beat package.json");
  const goWithHelper = detect({ "go.mod": "module x\n", "main.go": "", "package.json": pkg({ scripts: { build: "tailwindcss" } }) });
  assert.strictEqual(goWithHelper.id, "go", "a compiled language wins over a helper package.json");
  assert.strictEqual(detectStack(mem({ "README.md": "# nothing to build" })), null, "nothing recognised → null (Nixpacks / native fallback)");
});

test("stacks: Node version, manifest helpers", () => {
  assert.strictEqual(detect({ "package.json": pkg({ scripts: { start: "node ." } }), ".nvmrc": "v20.11.0" }).plan.nodeMajor, "20");
  assert.strictEqual(detect({ "package.json": pkg({ scripts: { start: "node ." }, engines: { node: "18.x" } }) }).plan.nodeMajor, "18");
  assert.strictEqual(detect({ "package.json": pkg({ scripts: { start: "node ." }, engines: { node: ">=18" } }) }).plan.nodeMajor, "22");
  assert.strictEqual(cargoBinName("[package]\nname = \"svc\"\nversion = \"1\"\n"), "svc");
  assert.deepStrictEqual(pyprojectDependencies(`[project]\nname = "x"\ndependencies = [\n  "flask>=3",\n  'gunicorn',\n]\n\n[tool.x]\ndependencies = ["no"]\n`), ["flask>=3", "gunicorn"]);
  const sveltekitAuto = detect({ "package.json": pkg({ devDependencies: { "@sveltejs/kit": "2", "@sveltejs/adapter-auto": "3" } }) });
  assert.match(sveltekitAuto.notes.join(" "), /adapter-node/);
});

// ─── DOCKERFILE CONTENT ──────────────────────────────────────────────────────

test("stacks: Dockerfile listens on PORT, runs the start command, uses lockfile installs", () => {
  const express = detect(FIXTURES[0].files);
  const text = dockerfile(express);
  assert.match(text, /^FROM node:22-bookworm-slim$/m);
  assert.match(text, /^ENV PORT=3000 HOST=0\.0\.0\.0 HOSTNAME=0\.0\.0\.0 NODE_ENV=production$/m);
  assert.match(text, /^EXPOSE 3000$/m);
  assert.match(text, /^CMD \["sh", "-c", "exec npm run start"\]$/m);
  assert.match(text, /npm ci --include=dev/);
  // Manifests are copied before the source so code-only changes reuse the install layer.
  assert.ok(text.indexOf("COPY package.json") < text.indexOf("COPY . ."));

  const pnpm = dockerfile(detect(FIXTURES.find((f) => f.name === "pnpm lockfile v9")!.files));
  assert.match(pnpm, /npm install -g pnpm@10/);
  assert.match(pnpm, /pnpm install --frozen-lockfile/);

  const withPostinstall = dockerfile(detect({ "package.json": pkg({ scripts: { start: "node .", postinstall: "node scripts/setup.js" } }) }));
  assert.ok(withPostinstall.indexOf("COPY . .") < withPostinstall.indexOf("npm ci"), "install scripts that need the source run after COPY . .");

  assert.match(dockerfile(express, { port: 4321 }), /^ENV PORT=4321 /m, "the service port replaces the stack default");
  assert.match(dockerfile(express, { nodeMajor: "20" }), /^FROM node:20-bookworm-slim$/m);
});

test("stacks: service build/start commands replace the stack defaults", () => {
  const next = detect(FIXTURES[1].files);
  const text = dockerfile(next, { buildCommand: "npm run build:prod && echo \"done\"", startCommand: "node server.mjs" });
  assert.match(text, /^RUN \["\/bin\/sh", "-c", "npm run build:prod && echo \\"done\\""\]$/m, "the user build command runs in exec form");
  assert.ok(!text.includes('"npm run build"]'));
  assert.match(text, /^CMD \["sh", "-c", "exec node server\.mjs"\]$/m);
  assert.ok(!text.includes("npm run start"));

  const flask = detect(FIXTURES.find((f) => f.name === "flask")!.files);
  assert.match(dockerfile(flask, { startCommand: "python app.py; echo bye" }), /^CMD \["sh", "-c", "python app\.py; echo bye"\]$/m, "compound commands are not exec'd");
  const site = detect({ "index.html": "" });
  assert.match(dockerfile(site, { startCommand: "npx serve -l $PORT" }), /^FROM node:/m, "a static site with a start command runs on Node");
});

test("stacks: static sites are served by nginx with an SPA fallback", () => {
  const vite = detect(FIXTURES.find((f) => f.name === "vite react spa")!.files);
  const text = dockerfile(vite);
  assert.match(text, /^FROM node:22-bookworm-slim AS build$/m);
  assert.match(text, /^FROM nginx:1\.27-alpine$/m);
  assert.match(text, /try_files \$uri \$uri\/ \/index\.html;/);
  assert.match(text, /listen \$\{PORT\};/);
  assert.match(text, /^COPY --from=build \/out\/ \/usr\/share\/nginx\/html\/$/m);
  assert.match(text, /^ENV PORT=8080 HOST=0\.0\.0\.0$/m);
  const plain = dockerfile(detect({ "index.html": "" }));
  assert.ok(!/AS build/.test(plain), "a plain site has no build stage");
  assert.match(plain, /^COPY \. \/usr\/share\/nginx\/html\/$/m);
});

test("stacks: per-language Dockerfiles", () => {
  const go = dockerfile(detect(FIXTURES.find((f) => f.name === "go cmd/ package")!.files));
  assert.match(go, /^FROM golang:1\.22-bookworm AS build$/m);
  assert.match(go, /go build -trimpath -ldflags="-s -w" -o \/out\/app '\.\/cmd\/server'/);
  assert.match(go, /^FROM debian:bookworm-slim$/m);
  assert.match(go, /^CMD \["sh", "-c", "exec \/usr\/local\/bin\/app"\]$/m);

  const rust = dockerfile(detect(FIXTURES.find((f) => f.name === "rust [[bin]]")!.files));
  assert.match(rust, /^FROM rust:1-bookworm AS build$/m);
  assert.match(rust, /cargo build --release/);
  assert.match(rust, /b='api-server'/);

  const django = dockerfile(detect(FIXTURES.find((f) => f.name === "django")!.files));
  assert.match(django, /^FROM python:3\.12-slim$/m);
  assert.match(django, /pip install -r requirements\.txt && pip install 'gunicorn'/);
  assert.match(django, /collectstatic --noinput/);
  assert.ok(!django.includes("apt-get"), "psycopg2-binary ships wheels: no apt");
  const psycopg = dockerfile(detect({ "requirements.txt": "flask\npsycopg2==2.9\n", "app.py": "app = Flask(__name__)" }));
  assert.match(psycopg, /apt-get install -y --no-install-recommends gcc libpq-dev/, "psycopg2 from source needs libpq-dev");

  const laravel = dockerfile(detect(FIXTURES.find((f) => f.name === "laravel")!.files));
  assert.match(laravel, /^FROM composer:2 AS vendor$/m);
  assert.match(laravel, /^ENV APACHE_DOCUMENT_ROOT=\/var\/www\/html\/public$/m);
  assert.match(laravel, /Listen \$\{PORT\}/);
  assert.match(laravel, /php artisan package:discover/);

  const maven = dockerfile(detect(FIXTURES.find((f) => f.name === "maven")!.files));
  assert.match(maven, /\.\/mvnw -B -DskipTests package/);
  assert.match(maven, /^FROM eclipse-temurin:21-jre$/m);
  assert.match(maven, /-Dhttps\.proxyHost=/, "Maven gets the proxy as JVM flags");

  const rails = dockerfile(detect(FIXTURES.find((f) => f.name === "rails")!.files));
  assert.match(rails, /^FROM ruby:3\.2 AS build$/m);
  assert.match(rails, /^FROM ruby:3\.2-slim$/m);
  assert.match(rails, /libpq5/);

  const deno = dockerfile(detect(FIXTURES.find((f) => f.name === "deno")!.files));
  assert.match(deno, /^FROM denoland\/deno:/m);
  assert.match(deno, /deno cache 'main\.ts'/);

  const bun = dockerfile(detect(FIXTURES.find((f) => f.name === "bun")!.files));
  assert.match(bun, /^FROM oven\/bun:1$/m);
  assert.match(bun, /bun install --frozen-lockfile/);
});

test("stacks: the build CA block appears only with extraCaCert", () => {
  for (const fixture of FIXTURES) {
    const stack = detect(fixture.files);
    const without = dockerfile(stack);
    const withCa = dockerfile(stack, { extraCaCert: true });
    assert.ok(!without.includes("syncbay-build-ca.crt"), `${fixture.name}: no CA without extraCaCert`);
    if (stack.id === "static" && !stack.plan.needsBuild) continue; // nothing is downloaded
    if (stack.id === "php" && !stack.plan.composer) continue;
    assert.match(withCa, /^COPY syncbay-build-ca\.crt \/usr\/local\/share\/ca-certificates\/syncbay-build-ca\.crt$/m, `${fixture.name}: CA copied`);
    assert.match(withCa, /SSL_CERT_FILE=\/usr\/local\/share\/syncbay\/ca-bundle\.crt/);
    if (stack.id === "java") assert.match(withCa, /keytool -importcert/);
  }
  // The runtime image never carries the build CA.
  const go = dockerfile(detect({ "go.mod": "module x\n", "main.go": "" }), { extraCaCert: true });
  assert.strictEqual(go.split("COPY syncbay-build-ca.crt").length - 1, 1);
  assert.ok(go.lastIndexOf("syncbay-build-ca.crt") < go.indexOf("FROM debian:bookworm-slim"));
});

test("stacks: templates on the verified path need no apt-get", () => {
  for (const name of ["express", "next", "vite react spa", "plain html", "flask", "fastapi", "django", "go cmd/ package", "rust [[bin]]", "plain php", "laravel", "nestjs", "bun"]) {
    const text = dockerfile(detect(FIXTURES.find((f) => f.name === name)!.files), { extraCaCert: true });
    assert.ok(!text.includes("apt-get"), `${name} uses apt-get`);
  }
});

test("stacks: generated .dockerignore keeps the user's file and re-includes the build CA", () => {
  const node = detect(FIXTURES[0].files);
  const generated = generateDockerignore(node, null);
  assert.match(generated, /^node_modules$/m);
  assert.match(generated, /^\.git$/m);
  assert.match(generated, /^!syncbay-build-ca\.crt$/m);
  const merged = generateDockerignore(node, "*\n!src\n!package.json\n\n");
  assert.ok(merged.startsWith("*\n!src\n!package.json\n"), "the user's rules come first, unchanged");
  assert.match(merged, /\n!syncbay-build-ca\.crt\n$/);
  assert.ok(!merged.includes("node_modules"), "no defaults are added to a user's file");
  assert.match(generateDockerignore(detect({ "Cargo.toml": "[package]\nname=\"a\"\n" }), ""), /^target$/m);
});

// ─── BUILDER SELECTION ───────────────────────────────────────────────────────

test("stacks: builderPreference — service variable, then runner, then auto", () => {
  assert.deepStrictEqual(builderPreference({}, {}), { preference: "auto", source: "default" });
  assert.deepStrictEqual(builderPreference({}, { RUNNER_BUILDER: "nixpacks" }), { preference: "nixpacks", source: "RUNNER_BUILDER" });
  assert.deepStrictEqual(builderPreference({ SYNCBAY_BUILDER: " Template " }, { RUNNER_BUILDER: "nixpacks" }), { preference: "template", source: "SYNCBAY_BUILDER" });
  assert.deepStrictEqual(builderPreference({ SYNCBAY_BUILDER: "buildpacks" }, { RUNNER_BUILDER: "dockerfile" }), { preference: "auto", source: "SYNCBAY_BUILDER", invalid: "buildpacks" });
  assert.deepStrictEqual(builderPreference(undefined, { RUNNER_BUILDER: "" }), { preference: "auto", source: "default" });
});

test("stacks: dockerBuildFlags passes the network and proxy NAMES, never values", () => {
  const secretProxy = "http://user:hunter2@proxy.internal:3128";
  const flags = dockerBuildFlags({ RUNNER_BUILD_NETWORK: "host", HTTPS_PROXY: secretProxy, https_proxy: secretProxy, NO_PROXY: "localhost,.internal", HTTP_PROXY: "" });
  assert.deepStrictEqual(flags, ["--network host", "--build-arg HTTPS_PROXY", "--build-arg https_proxy", "--build-arg NO_PROXY"]);
  assert.ok(!flags.join(" ").includes("hunter2") && !flags.join(" ").includes("proxy.internal"));
  assert.ok(!flags.includes("--build-arg HTTP_PROXY"), "an empty variable is not passed");
  assert.deepStrictEqual(dockerBuildFlags({ RUNNER_BUILD_NETWORK: "host; rm -rf /" }), [], "only host | none | default");
  assert.deepStrictEqual(dockerBuildFlags({}), []);
});

// ─── PIPELINE STRATEGY (mock executor, real fixture files) ──────────────────

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sb-stacks-"));
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
let fixtureSeq = 0;

function writeFixture(files: Record<string, string>, exec?: MockPipelineExecutor): string {
  const dir = path.join(fixtureRoot, `p${++fixtureSeq}`);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
    exec?.mockedFiles.add(path.join(dir, rel));
  }
  return dir;
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FASTAPI = { "requirements.txt": "fastapi\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n" };
let mockPort = 38000;
const runMock = (exec: MockPipelineExecutor, opts: Record<string, unknown>) =>
  new BuildPipeline({ executor: exec, portManager: new PortManager({ rangeStart: (mockPort += 20), rangeEnd: mockPort + 19 }) }).execute({
    jobId: `stk_${fixtureSeq}_${mockPort}`,
    serviceName: "stack-test",
    ...opts,
  } as any);

test("stacks pipeline: auto builds a detected stack with the generated Dockerfile", async () => {
  const exec = new MockPipelineExecutor();
  const dir = writeFixture(FASTAPI, exec);
  const caFile = path.join(fixtureRoot, "corp-ca.crt");
  fs.writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  const logs: string[] = [];
  const result = await withEnv({ RUNNER_BUILDER: undefined, RUNNER_BUILD_NETWORK: "host", RUNNER_BUILD_CA_FILE: caFile }, () =>
    runMock(exec, { workDir: dir, onLog: (l: string) => logs.push(l) })
  );
  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(result.strategy, "template");
  assert.strictEqual(result.stack, "python/FastAPI");
  assert.strictEqual(result.containerPort, 8000, "the stack's port is used when the service sets none");
  const build = exec.commands.find((c) => c.startsWith("docker build"))!;
  assert.ok(build.includes(`-f '${path.join(dir, "Dockerfile.syncbay")}'`), build);
  assert.ok(build.includes("--network host"));
  assert.ok(exec.commands.some((c) => c.startsWith("docker run") && c.includes(":8000 ")));
  const generated = fs.readFileSync(path.join(dir, "Dockerfile.syncbay"), "utf8");
  assert.match(generated, /uvicorn main:app --host 0\.0\.0\.0 --port \$PORT/);
  assert.match(generated, /^COPY syncbay-build-ca\.crt /m);
  assert.match(fs.readFileSync(path.join(dir, "Dockerfile.syncbay.dockerignore"), "utf8"), /__pycache__/);
  assert.ok(!fs.existsSync(path.join(dir, "syncbay-build-ca.crt")), "the CA copy is removed after the build");
  assert.match(logs.join("\n"), /Detected Python \(FastAPI\) from requirements\.txt/);
});

test("stacks pipeline: SYNCBAY_BUILDER=nixpacks forces Nixpacks for a detected stack", async () => {
  const exec = new MockPipelineExecutor();
  const dir = writeFixture(FASTAPI, exec);
  const result = await runMock(exec, { workDir: dir, environmentVariables: { SYNCBAY_BUILDER: "nixpacks" } });
  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(result.strategy, "nixpacks");
  assert.strictEqual(result.stack, "python/FastAPI", "the detected stack is still reported");
  assert.ok(exec.commands.some((c) => c.startsWith("nixpacks build")));
  assert.ok(!exec.commands.some((c) => c.includes("Dockerfile.syncbay")));
});

test("stacks pipeline: a forced builder that cannot run fails clearly", async () => {
  const exec = new MockPipelineExecutor();
  const dir = writeFixture(FASTAPI, exec);
  const result = await runMock(exec, { workDir: dir, environmentVariables: { SYNCBAY_BUILDER: "dockerfile" } });
  assert.strictEqual(result.success, false);
  assert.match(result.error || "", /SYNCBAY_BUILDER=dockerfile, but there is no Dockerfile/);
  assert.ok(!exec.commands.some((c) => c.startsWith("docker build")));
});

test("stacks pipeline: a user Dockerfile wins in auto mode", async () => {
  const exec = new MockPipelineExecutor();
  const dir = writeFixture({ ...FASTAPI, Dockerfile: "FROM python:3.12-slim\n" }, exec);
  const logs: string[] = [];
  const result = await runMock(exec, { workDir: dir, onLog: (l: string) => logs.push(l) });
  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(result.strategy, "dockerfile");
  const build = exec.commands.find((c) => c.startsWith("docker build"))!;
  assert.ok(build.includes(`'${path.join(dir, "Dockerfile")}'`) && !build.includes("Dockerfile.syncbay"), build);
  assert.match(logs.join("\n"), /set SYNCBAY_BUILDER=template/);
  const forced = await runMock(exec, { workDir: dir, environmentVariables: { SYNCBAY_BUILDER: "template" } });
  assert.strictEqual(forced.strategy, "template", "SYNCBAY_BUILDER=template overrides the Dockerfile");
});

test("stacks pipeline: the runner's starter app never goes to the template builder", async () => {
  const exec = new MockPipelineExecutor();
  const dir = path.join(fixtureRoot, `starter${++fixtureSeq}`);
  const auto = await runMock(exec, { workDir: dir });
  assert.strictEqual(auto.success, true, auto.error);
  assert.strictEqual(auto.strategy, "nixpacks");
  assert.strictEqual(auto.stack, undefined);
  assert.ok(fs.existsSync(path.join(dir, ".syncbay-starter")));
  // A redeploy of the same workspace still sees the starter (its package.json is now on disk).
  const again = await runMock(exec, { workDir: dir });
  assert.strictEqual(again.strategy, "nixpacks");
  const forced = await withEnv({ RUNNER_BUILDER: "template" }, () => runMock(new MockPipelineExecutor(), { workDir: dir }));
  assert.strictEqual(forced.success, false);
  assert.match(forced.error || "", /RUNNER_BUILDER=template, but no supported stack was detected/);
});

test("stacks pipeline: stackFilesFor reads the real directory", () => {
  const dir = writeFixture({ "go.mod": "module example.com/x\n", "cmd/api/main.go": "package main" });
  const files = stackFilesFor(dir);
  assert.ok(files.exists("cmd/api"));
  assert.deepStrictEqual(files.list!("cmd"), ["api"]);
  assert.strictEqual(files.read("missing.txt"), null);
  assert.strictEqual(files.read("cmd"), null, "a directory is not read as a file");
  assert.strictEqual(detectStack(files)?.plan.goPackage, "./cmd/api");
});

// ─── Security: repository-controlled files (audit findings) ─────────────────────

test("security: a symlink planted as a generated file is replaced, never written through", async () => {
  const exec = new MockPipelineExecutor();
  const dir = writeFixture(FASTAPI, exec);
  const victim = path.join(fixtureRoot, `victim-${fixtureSeq}.txt`);
  fs.writeFileSync(victim, "host file");
  const ignoreVictim = path.join(fixtureRoot, `victim-ignore-${fixtureSeq}.txt`);
  fs.writeFileSync(ignoreVictim, "host file");
  const caVictim = path.join(fixtureRoot, `victim-ca-${fixtureSeq}.txt`);
  fs.writeFileSync(caVictim, "host file");
  fs.symlinkSync(victim, path.join(dir, "Dockerfile.syncbay"));
  fs.symlinkSync(ignoreVictim, path.join(dir, "Dockerfile.syncbay.dockerignore"));
  fs.symlinkSync(caVictim, path.join(dir, "syncbay-build-ca.crt"));
  fs.symlinkSync("/proc/self/environ", path.join(dir, ".dockerignore"));
  const caFile = path.join(fixtureRoot, "corp-ca-2.crt");
  fs.writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n");
  const result = await withEnv({ RUNNER_BUILDER: undefined, RUNNER_BUILD_CA_FILE: caFile, RUNNER_SECRET: "audit-secret-value" }, () => runMock(exec, { workDir: dir }));
  assert.strictEqual(result.success, true, result.error);
  for (const f of [victim, ignoreVictim, caVictim]) assert.strictEqual(fs.readFileSync(f, "utf8"), "host file", `${f} was not overwritten`);
  assert.ok(!fs.lstatSync(path.join(dir, "Dockerfile.syncbay")).isSymbolicLink(), "the generated Dockerfile is a regular file");
  assert.ok(!fs.readFileSync(path.join(dir, "Dockerfile.syncbay.dockerignore"), "utf8").includes("audit-secret-value"), "a symlinked .dockerignore is not read");
});

test("security: readRepoFile refuses symlinks and FIFOs; writeOwnFile replaces a dangling link", async () => {
  const dir = writeFixture({ "real.txt": "ok" });
  fs.symlinkSync("/etc/hostname", path.join(dir, "link.txt"));
  assert.strictEqual(await readRepoFile(path.join(dir, "real.txt")), "ok");
  assert.strictEqual(await readRepoFile(path.join(dir, "link.txt")), null);
  const target = path.join(fixtureRoot, `dangling-${fixtureSeq}`);
  fs.symlinkSync(target, path.join(dir, "out.txt"));
  await writeOwnFile(path.join(dir, "out.txt"), "mine");
  assert.ok(!fs.existsSync(target), "the link target was not created");
  assert.strictEqual(fs.readFileSync(path.join(dir, "out.txt"), "utf8"), "mine");
});

test("security: stackFilesFor ignores manifests that are symlinks out of the repository", () => {
  const outside = writeFixture({ "package.json": JSON.stringify({ dependencies: { express: "4" } }) });
  const dir = writeFixture({ "README.md": "x" });
  fs.symlinkSync(path.join(outside, "package.json"), path.join(dir, "package.json"));
  assert.strictEqual(stackFilesFor(dir).read("package.json"), null);
  assert.strictEqual(stackFilesFor(dir).exists("package.json"), false);
});

test("security: a root directory outside the repository is refused", async () => {
  const exec = new MockPipelineExecutor();
  const dir = writeFixture(FASTAPI, exec);
  for (const rootDir of ["../..", "/etc", "a/../../x"]) {
    const result = await runMock(exec, { workDir: dir, rootDir });
    assert.strictEqual(result.success, false, rootDir);
    assert.match(result.error || "", /root directory/i);
  }
  fs.symlinkSync("/tmp", path.join(dir, "escape"));
  const viaLink = await runMock(exec, { workDir: dir, rootDir: "escape" });
  assert.strictEqual(viaLink.success, false);
  assert.match(viaLink.error || "", /outside the repository/);
});

test("security: native app processes do not inherit the runner's secrets", () => {
  return withEnv({ RUNNER_SECRET: "s", CLOUDFLARE_API_TOKEN: "t", SYNCBAY_WEBHOOK_SECRET: "w", R2_SECRET_ACCESS_KEY: "r", PATH_EXTRA_OK: "1" }, async () => {
    const env = hostEnvForApps();
    for (const k of ["RUNNER_SECRET", "CLOUDFLARE_API_TOKEN", "SYNCBAY_WEBHOOK_SECRET", "R2_SECRET_ACCESS_KEY"]) assert.ok(!(k in env), k);
    assert.strictEqual(env.PATH_EXTRA_OK, "1");
  });
});

test("stacks: a plain server.js without package.json is a Node app with nothing to install", () => {
  const dir = writeFixture({ "server.js": "require('http').createServer().listen(process.env.PORT)" });
  const stack = detectStack(stackFilesFor(dir))!;
  assert.strictEqual(stack.id, "node");
  const df = generateDockerfile(stack, {} as any);
  assert.ok(!/npm (ci|install)/.test(df) && !/COPY package\.json/.test(df), df);
  assert.match(df, /node server\.js/);
});

test("stacks: service variables are declared as ARGs in build stages only", () => {
  const vite = detectStack(stackFilesFor(writeFixture({ "package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "5" } }), "index.html": "<html></html>" })))!;
  const df = generateDockerfile(vite, { port: 8080, buildArgs: ["VITE_API", "PORT", "bad-name", "NPM_TOKEN"] });
  const stages = df.split(/^FROM /m).slice(1);
  assert.ok(stages.length > 1, "SPA builds are multi-stage");
  assert.match(stages[0], /^ARG NPM_TOKEN$/m);
  assert.match(stages[0], /^ARG VITE_API$/m);
  assert.ok(!/ARG (PORT|bad-name)/.test(df), "runtime-only and invalid names are skipped");
  assert.ok(!/^ARG /m.test(stages[stages.length - 1]), "the runtime stage gets no build args");
  const flask = detectStack(stackFilesFor(writeFixture(FASTAPI)))!;
  assert.match(generateDockerfile(flask, { port: 8000, buildArgs: ["SECRET_KEY"] }), /^FROM [^\n]+\nARG SECRET_KEY$/m);
  // PHP's final stage runs Composer and the build command, so it gets the args as well.
  const php = detectStack(stackFilesFor(writeFixture({ "composer.json": JSON.stringify({ require: { php: ">=8.1" } }), "index.php": "<?php echo 1;" })))!;
  const phpStages = generateDockerfile(php, { port: 8080, buildCommand: "php build.php", buildArgs: ["APP_KEY"] }).split(/^FROM /m).slice(1);
  assert.ok(phpStages.length > 1, "Composer builds are multi-stage");
  for (const stage of phpStages) assert.match(stage, /^ARG APP_KEY$/m, stage.split("\n")[0]);
});
