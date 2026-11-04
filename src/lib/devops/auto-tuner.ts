/**
 * Syncbay PaaS — Framework detector & settings suggestions (heuristic)
 *
 * Rule-based: matches repository file names / package.json against known
 * frameworks and returns suggested build/start commands, port, cache dirs and
 * env presets. Nothing is applied to the service; `optimizationNotes` are
 * recommendations the user can adopt.
 */

export interface FrameworkTuningResult {
  frameworkName: string;
  category: "Fullstack" | "Frontend" | "Backend API" | "Microservice";
  buildCommand: string;
  startCommand: string;
  port: number;
  healthCheckUrl: string;
  instanceType: "lite" | "standard-1" | "standard-2";
  scaleToZero: boolean;
  idleTimeoutSecs: number;
  cacheDirectories: string[];
  recommendedEnvPresets: Record<string, string>;
  /** Suggestions only — nothing here has been applied to a service. */
  optimizationNotes: string[];
  /** Always "heuristic": derived from file-name rules, not from builds or profiling. */
  method: "heuristic";
  applied: false;
}

export function autoTuneFramework(files: string[], packageJsonContent?: string): FrameworkTuningResult {
  const fileSet = new Set(files.map((f) => f.toLowerCase()));

  // 1. Next.js Detection
  if (
    fileSet.has("next.config.js") ||
    fileSet.has("next.config.mjs") ||
    fileSet.has("next.config.ts") ||
    (packageJsonContent && packageJsonContent.includes('"next"'))
  ) {
    return {
      frameworkName: "Next.js (App / Pages Router)",
      category: "Fullstack",
      buildCommand: "npm run build",
      startCommand: "npm run start",
      port: 3000,
      healthCheckUrl: "/api/health",
      instanceType: "standard-1",
      scaleToZero: true,
      idleTimeoutSecs: 300,
      cacheDirectories: [".next/cache", "node_modules/.cache"],
      recommendedEnvPresets: {
        NODE_ENV: "production",
        PORT: "3000",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      optimizationNotes: [
        'Suggest `output: "standalone"` in next.config and caching .next/cache between builds',
        "Suggest scale-to-zero with a 300 s idle timeout",
        "Suggest long-lived Cache-Control headers for _next/static assets",
      ],
      method: "heuristic",
      applied: false,
    };
  }

  // 2. Nuxt 3 Detection
  if (
    fileSet.has("nuxt.config.js") ||
    fileSet.has("nuxt.config.ts") ||
    (packageJsonContent && packageJsonContent.includes('"nuxt"'))
  ) {
    return {
      frameworkName: "Nuxt 3",
      category: "Fullstack",
      buildCommand: "npm run build",
      startCommand: "node .output/server/index.mjs",
      port: 3000,
      healthCheckUrl: "/",
      instanceType: "standard-1",
      scaleToZero: true,
      idleTimeoutSecs: 300,
      cacheDirectories: [".nuxt", "node_modules/.cache"],
      recommendedEnvPresets: {
        NODE_ENV: "production",
        PORT: "3000",
        NITRO_PRESET: "node-server",
      },
      optimizationNotes: [
        "Suggest the Nitro node-server preset for container deploys",
        "Suggest caching .nuxt between builds",
      ],
      method: "heuristic",
      applied: false,
    };
  }

  // 3. Remix Detection
  if (
    fileSet.has("remix.config.js") ||
    (packageJsonContent && packageJsonContent.includes('"@remix-run"'))
  ) {
    return {
      frameworkName: "Remix Run",
      category: "Fullstack",
      buildCommand: "npm run build",
      startCommand: "npm run start",
      port: 3000,
      healthCheckUrl: "/",
      instanceType: "standard-1",
      scaleToZero: true,
      idleTimeoutSecs: 300,
      cacheDirectories: ["build", "node_modules/.cache"],
      recommendedEnvPresets: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      optimizationNotes: [
        "Suggest Cache-Control headers for SSR responses",
      ],
      method: "heuristic",
      applied: false,
    };
  }

  // 4. Astro Detection
  if (
    fileSet.has("astro.config.mjs") ||
    fileSet.has("astro.config.ts") ||
    (packageJsonContent && packageJsonContent.includes('"astro"'))
  ) {
    return {
      frameworkName: "Astro",
      category: "Frontend",
      buildCommand: "npm run build",
      startCommand: "node ./dist/server/entry.mjs",
      port: 4321,
      healthCheckUrl: "/",
      instanceType: "lite",
      scaleToZero: true,
      idleTimeoutSecs: 180,
      cacheDirectories: ["dist", "node_modules/.cache"],
      recommendedEnvPresets: {
        NODE_ENV: "production",
        PORT: "4321",
        HOST: "0.0.0.0",
      },
      optimizationNotes: [
        "Suggest static output where pages need no server rendering",
      ],
      method: "heuristic",
      applied: false,
    };
  }

  // 5. Python FastAPI / Django
  if (fileSet.has("requirements.txt") || fileSet.has("pyproject.toml") || fileSet.has("main.py")) {
    const isFastApi = files.some((f) => f.includes("main.py") || f.includes("app.py"));
    return {
      frameworkName: isFastApi ? "Python FastAPI / Uvicorn" : "Python WSGI / Django",
      category: "Backend API",
      buildCommand: "pip install -r requirements.txt",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
      port: 8000,
      healthCheckUrl: "/health",
      instanceType: "standard-1",
      scaleToZero: true,
      idleTimeoutSecs: 300,
      cacheDirectories: ["~/.cache/pip"],
      recommendedEnvPresets: {
        PYTHONUNBUFFERED: "1",
        PORT: "8000",
      },
      optimizationNotes: [
        "Suggest PYTHONUNBUFFERED=1 so logs stream in real time",
        "Suggest running Uvicorn with multiple workers",
      ],
      method: "heuristic",
      applied: false,
    };
  }

  // 6. Go (Golang)
  if (fileSet.has("go.mod")) {
    return {
      frameworkName: "Go (Golang High-Performance Binary)",
      category: "Microservice",
      buildCommand: "go build -o server .",
      startCommand: "./server",
      port: 8080,
      healthCheckUrl: "/health",
      instanceType: "lite",
      scaleToZero: true,
      idleTimeoutSecs: 300,
      cacheDirectories: ["/root/go/pkg/mod"],
      recommendedEnvPresets: {
        PORT: "8080",
        GIN_MODE: "release",
      },
      optimizationNotes: [
        "Suggest -ldflags='-s -w' to shrink the binary",
        "Static Go binaries usually start quickly from scale-to-zero",
      ],
      method: "heuristic",
      applied: false,
    };
  }

  // 7. Rust
  if (fileSet.has("cargo.toml")) {
    return {
      frameworkName: "Rust (Actix / Axum)",
      category: "Microservice",
      buildCommand: "cargo build --release",
      startCommand: "./target/release/server",
      port: 8080,
      healthCheckUrl: "/health",
      instanceType: "standard-1",
      scaleToZero: true,
      idleTimeoutSecs: 300,
      cacheDirectories: ["target", "/usr/local/cargo/registry"],
      recommendedEnvPresets: {
        RUST_LOG: "info",
        PORT: "8080",
      },
      optimizationNotes: [
        "Suggest caching target/ and the Cargo registry between builds",
      ],
      method: "heuristic",
      applied: false,
    };
  }

  // Default Node.js / Express
  return {
    frameworkName: "Node.js (Express / HTTP Server)",
    category: "Backend API",
    buildCommand: "npm install && npm run build",
    startCommand: "npm run start",
    port: 3000,
    healthCheckUrl: "/health",
    instanceType: "lite",
    scaleToZero: true,
    idleTimeoutSecs: 300,
    cacheDirectories: ["node_modules/.cache"],
    recommendedEnvPresets: {
      NODE_ENV: "production",
      PORT: "3000",
    },
    optimizationNotes: [
      "Detected Node.js package scripts",
    ],
    method: "heuristic",
      applied: false,
  };
}
