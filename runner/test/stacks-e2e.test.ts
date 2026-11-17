/**
 * Syncbay stack templates against a REAL Docker daemon: each case writes a small project with no
 * Dockerfile, deploys it through BuildPipeline + DefaultPipelineExecutor (auto builder → generated
 * `Dockerfile.syncbay`), and fetches a page from the host port. Skipped when `docker info` fails.
 *
 *   express, next, vite-react (deep route → index.html), static, flask, fastapi, django,
 *   go (net/http), rust (std TcpListener), php (composer + packagist); angular with E2E_ANGULAR=1
 *
 * Run: cd runner && npm run test:stacks   (ports 46200-46299)
 *   E2E_STACKS=flask,go   only these cases
 *   E2E_ANGULAR=1         also build an Angular 19 app (slow)
 * Behind an egress proxy: RUNNER_BUILD_NETWORK defaults to "host" here and RUNNER_BUILD_CA_FILE to
 * /root/.ccr/ca-bundle.crt when that file exists (override either through the environment).
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PortManager } from "../src/port-manager.ts";
import { BuildPipeline, DefaultPipelineExecutor } from "../src/pipeline.ts";

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
const dockerOk = docker("info", "--format", "{{.ServerVersion}}").status === 0;
const skipAll = dockerOk ? false : "Docker is not available";

process.env.RUNNER_BUILD_NETWORK ??= "host";
if (process.env.RUNNER_BUILD_CA_FILE === undefined && fs.existsSync("/root/.ccr/ca-bundle.crt")) process.env.RUNNER_BUILD_CA_FILE = "/root/.ccr/ca-bundle.crt";

const only = (process.env.E2E_STACKS || "").split(",").map((s) => s.trim()).filter(Boolean);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-stacks-e2e-"));
const run = Date.now().toString(36).slice(-6);
const portManager = new PortManager({ rangeStart: 46200, rangeEnd: 46299 });
const pipeline = new BuildPipeline({ executor: new DefaultPipelineExecutor(), portManager });
const started: string[] = [];

type Row = { stack: string; detected?: string; built: boolean; started: boolean; ok200: boolean; buildSecs?: number; totalSecs?: number; note?: string };
const rows: Row[] = [];

interface Case {
  /** Files of the project, relative path → content. */
  files: Record<string, string>;
  /** Expected `PipelineResult.stack` prefix, e.g. "python/Flask". */
  stack: string;
  /** Path fetched after the deploy and the text its body must contain. */
  path: string;
  marker: string;
  /** Service variables of the deploy. */
  env?: Record<string, string>;
}

const pkg = (body: object) => JSON.stringify({ name: "e2e-app", version: "1.0.0", private: true, ...body }, null, 2);

const CASES: Record<string, Case> = {
  express: {
    stack: "node/Express",
    path: "/",
    marker: "express-marker",
    files: {
      "package.json": pkg({ scripts: { start: "node server.js" }, dependencies: { express: "^4.21.2" } }),
      "server.js": `const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("express-marker"));
app.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log("listening"));
`,
    },
  },
  next: {
    stack: "node/Next.js",
    path: "/",
    marker: "next-marker",
    files: {
      "package.json": pkg({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15.1.6", react: "19.0.0", "react-dom": "19.0.0" } }),
      "app/layout.js": `export const metadata = { title: "e2e" };
export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
      "app/page.js": `export default function Page() {
  return <main>next-marker</main>;
}
`,
    },
  },
  "vite-react": {
    stack: "static/React (Vite)",
    // A client-side route: nginx falls back to index.html.
    path: "/some/deep/route",
    // The title comes from a service variable at build time (Vite replaces %VITE_*% in index.html):
    // template builds must receive the service's variables, as Nixpacks builds do.
    marker: "vite-marker-from-build-env",
    env: { VITE_TITLE: "vite-marker-from-build-env" },
    files: {
      "package.json": pkg({
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
        devDependencies: { vite: "^5.4.11", "@vitejs/plugin-react": "^4.3.4" },
      }),
      "vite.config.js": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });
`,
      "index.html": `<!doctype html>
<html><head><meta charset="UTF-8" /><title>%VITE_TITLE%</title></head>
<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>
`,
      "src/main.jsx": `import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")).render(<h1>Hello from Vite</h1>);
`,
    },
  },
  static: {
    stack: "static",
    path: "/",
    marker: "static-marker",
    files: {
      "index.html": `<!doctype html><html><head><title>static</title></head><body>static-marker</body></html>\n`,
      "about.html": `<!doctype html><html><body>about</body></html>\n`,
    },
  },
  flask: {
    stack: "python/Flask",
    path: "/",
    marker: "flask-marker",
    files: {
      "requirements.txt": "flask==3.1.0\n",
      "app.py": `from flask import Flask

app = Flask(__name__)


@app.get("/")
def index():
    return "flask-marker"
`,
    },
  },
  fastapi: {
    stack: "python/FastAPI",
    path: "/",
    marker: "fastapi-marker",
    files: {
      "requirements.txt": "fastapi==0.115.6\n",
      "main.py": `from fastapi import FastAPI
from fastapi.responses import PlainTextResponse

app = FastAPI()


@app.get("/", response_class=PlainTextResponse)
def index():
    return "fastapi-marker"
`,
    },
  },
  django: {
    stack: "python/Django",
    path: "/",
    marker: "django-marker",
    files: {
      "requirements.txt": "Django==5.1.4\n",
      "manage.py": `#!/usr/bin/env python
import os
import sys

if __name__ == "__main__":
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)
`,
      "mysite/__init__.py": "",
      "mysite/settings.py": `SECRET_KEY = "e2e-not-secret"
DEBUG = False
ALLOWED_HOSTS = ["*"]
ROOT_URLCONF = "mysite.urls"
INSTALLED_APPS = ["django.contrib.staticfiles"]
MIDDLEWARE = []
DATABASES = {}
STATIC_URL = "static/"
STATIC_ROOT = "staticfiles"
USE_TZ = True
`,
      "mysite/urls.py": `from django.http import HttpResponse
from django.urls import path

urlpatterns = [path("", lambda request: HttpResponse("django-marker"))]
`,
      "mysite/wsgi.py": `import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")
application = get_wsgi_application()
`,
    },
  },
  go: {
    stack: "go",
    path: "/",
    marker: "go-marker",
    files: {
      "go.mod": "module example.com/hello\n\ngo 1.22\n",
      "main.go": `package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "go-marker") })
	if err := http.ListenAndServe("0.0.0.0:"+port, nil); err != nil {
		panic(err)
	}
}
`,
    },
  },
  rust: {
    stack: "rust",
    path: "/",
    marker: "rust-marker",
    files: {
      "Cargo.toml": `[package]
name = "hello"
version = "0.1.0"
edition = "2021"

[dependencies]
`,
      "src/main.rs": `use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).expect("bind");
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let body = "rust-marker";
        let _ = write!(stream, "HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{}", body.len(), body);
    }
}
`,
    },
  },
  php: {
    stack: "php",
    path: "/",
    marker: "php-marker",
    // Composer with a PSR-4 autoload and no remote packages: package dists are GitHub zipballs,
    // which some egress proxies refuse (E2E_PHP_PACKAGE=1 adds psr/log from packagist).
    files: {
      "composer.json": JSON.stringify(
        { name: "syncbay/e2e", require: process.env.E2E_PHP_PACKAGE === "1" ? { "psr/log": "^3.0" } : {}, autoload: { "psr-4": { "App\\": "src/" } } },
        null,
        2
      ),
      "src/Greeter.php": `<?php
namespace App;

final class Greeter
{
    public static function marker(): string
    {
        return 'php-marker';
    }
}
`,
      "index.php": `<?php
require __DIR__ . '/vendor/autoload.php';
echo \\App\\Greeter::marker() . ' on PHP ' . PHP_VERSION;
`,
    },
  },
};

if (process.env.E2E_ANGULAR === "1") {
  const v = "^19.0.0";
  CASES.angular = {
    stack: "static/Angular",
    path: "/deep/link",
    marker: "angular-marker",
    files: {
      "package.json": pkg({
        scripts: { ng: "ng", build: "ng build" },
        dependencies: { "@angular/common": v, "@angular/compiler": v, "@angular/core": v, "@angular/platform-browser": v, rxjs: "~7.8.0", tslib: "^2.3.0", "zone.js": "~0.15.0" },
        devDependencies: { "@angular/build": v, "@angular/cli": v, "@angular/compiler-cli": v, typescript: "~5.6.2" },
      }),
      "angular.json": JSON.stringify(
        {
          $schema: "./node_modules/@angular/cli/lib/config/schema.json",
          version: 1,
          newProjectRoot: "projects",
          projects: {
            "e2e-ng": {
              projectType: "application",
              root: "",
              sourceRoot: "src",
              architect: {
                build: {
                  builder: "@angular/build:application",
                  options: { outputPath: "dist/e2e-ng", index: "src/index.html", browser: "src/main.ts", polyfills: ["zone.js"], tsConfig: "tsconfig.json" },
                  configurations: { production: { outputHashing: "all" } },
                  defaultConfiguration: "production",
                },
              },
            },
          },
          cli: { analytics: false },
        },
        null,
        2
      ),
      "tsconfig.json": JSON.stringify(
        { compileOnSave: false, compilerOptions: { strict: true, target: "ES2022", module: "ES2022", moduleResolution: "bundler", lib: ["ES2022", "dom"], skipLibCheck: true }, files: ["src/main.ts"] },
        null,
        2
      ),
      "src/index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>angular-marker</title><base href="/"></head>
<body><app-root></app-root></body></html>
`,
      "src/main.ts": `import { Component } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";

@Component({ selector: "app-root", standalone: true, template: "<h1>Hello from Angular</h1>" })
class AppComponent {}

bootstrapApplication(AppComponent).catch((err) => console.error(err));
`,
    },
  };
}

function writeProject(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

async function fetchWithRetry(url: string, attempts = 20): Promise<{ status: number; body: string }> {
  let last: { status: number; body: string } = { status: 0, body: "" };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      last = { status: res.status, body: await res.text() };
      if (res.status === 200) return last;
    } catch (err: any) {
      last = { status: 0, body: String(err?.message || err) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

test.after(async () => {
  for (const id of started) await pipeline.stopContainer(id).catch(() => null);
  for (const name of docker("ps", "-aq", "--filter", "name=syncbay-stk-").stdout.split("\n").filter(Boolean)) docker("rm", "-f", name);
  const images = docker("images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", "reference=syncbay-stk-*").stdout.split("\n").filter(Boolean);
  if (images.length) docker("rmi", "-f", ...images);
  fs.rmSync(root, { recursive: true, force: true });
  if (rows.length) {
    const line = (r: Row) =>
      `| ${r.stack.padEnd(10)} | ${(r.detected || "-").padEnd(24)} | ${(r.built ? "yes" : "no").padEnd(5)} | ${(r.started ? "yes" : "no").padEnd(7)} | ${(r.ok200 ? "yes" : "no").padEnd(8)} | ${(r.buildSecs?.toFixed(1) ?? "-").padStart(7)} | ${(r.totalSecs?.toFixed(1) ?? "-").padStart(7)} |${r.note ? ` ${r.note}` : ""}`;
    console.log(["", "| stack      | detected                 | built | started | HTTP 200 | build s | total s |", "|---|---|---|---|---|---|---|", ...rows.map(line)].join("\n"));
  }
});

for (const [name, c] of Object.entries(CASES)) {
  const skip = skipAll || (only.length && !only.includes(name) ? `not in E2E_STACKS` : false);
  test(`stack template: ${name}`, { skip, timeout: 30 * 60_000 }, async () => {
    const dir = writeProject(name, c.files);
    const logs: string[] = [];
    const row: Row = { stack: name, built: false, started: false, ok200: false };
    rows.push(row);
    const startedAt = Date.now();
    const result = await pipeline.execute({
      jobId: `${name.replace(/[^a-z]/g, "").slice(0, 4)}${run}`,
      deploymentId: `dep${name}${run}`,
      serviceId: `svc-stk-${name}-${run}`,
      serviceName: `stk-${name}`,
      workDir: dir,
      healthCheckTimeoutMs: 120_000,
      environmentVariables: c.env,
      onLog: (line) => logs.push(line),
    });
    row.totalSecs = (Date.now() - startedAt) / 1000;
    if (result.containerId) started.push(result.containerId);
    row.detected = result.stack;
    const built = /build succeeded for image \S+ in ([\d.]+)s/.exec(logs.join("\n"));
    row.built = Boolean(built);
    if (built) row.buildSecs = Number(built[1]);
    row.started = result.success;
    if (!result.success) row.note = (result.error || "").split("\n").slice(-3).join(" ").slice(0, 200);
    assert.strictEqual(result.success, true, `${result.error}\n--- last log lines ---\n${logs.slice(-40).join("\n")}`);
    assert.strictEqual(result.strategy, "template");
    assert.ok(result.stack?.startsWith(c.stack), `stack ${result.stack} should start with ${c.stack}`);
    const res = await fetchWithRetry(`http://127.0.0.1:${result.assignedPort}${c.path}`);
    row.ok200 = res.status === 200 && res.body.includes(c.marker);
    assert.strictEqual(res.status, 200, res.body.slice(0, 500));
    assert.ok(res.body.includes(c.marker), `body should contain ${c.marker}: ${res.body.slice(0, 500)}`);
  });
}
