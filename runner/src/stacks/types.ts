/**
 * Types shared by stack detection (`detect.ts`) and Dockerfile generation (`dockerfile.ts`).
 * Both are pure: they read a project through `StackFiles` and return values, nothing else.
 */

/** Read-only view of a project directory. Paths are relative to the project root, with `/`. */
export interface StackFiles {
  exists(rel: string): boolean;
  /** File content, or null when it does not exist or cannot be read. */
  read(rel: string): string | null;
  /** Names of the entries in a directory (optional; used to find `cmd/<name>` Go packages). */
  list?(rel: string): string[];
}

export type StackId = "node" | "static" | "python" | "go" | "rust" | "php" | "java" | "ruby" | "deno" | "bun";

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "yarn-berry" | "bun";

/** Stack-specific facts the Dockerfile generator needs. Only the fields of the detected stack are set. */
export interface StackPlan {
  // Node / Bun / static SPA builds
  packageManager?: NodePackageManager;
  /** pnpm major (or exact version from `packageManager`) to install. */
  pnpmVersion?: string;
  nodeMajor?: string;
  /** No package.json: a plain `node server.js` app, nothing to install. */
  noManifest?: boolean;
  /** True when install scripts need the whole source tree (postinstall, prepare, yarn berry …). */
  installNeedsSource?: boolean;
  /** Static output directory, relative to the project root ("." for a plain site). */
  outputDir?: string;
  /** Further directories tried, in order, when `outputDir` has no index.html after the build. */
  outputCandidates?: string[];
  /** Whether a static site needs a Node build step. */
  needsBuild?: boolean;
  // Python
  pythonVersion?: string;
  pythonInstall?: "requirements" | "poetry" | "uv" | "pipenv" | "pyproject" | "none";
  /** `[project].dependencies` of a pyproject.toml without a lockfile. */
  pythonDeps?: string[];
  /** Packages added because the default start command needs them (gunicorn, uvicorn). */
  pythonExtras?: string[];
  djangoProject?: string;
  /** System libraries a Python dependency needs to compile (installed with apt). */
  aptPackages?: string[];
  // Go
  goVersion?: string;
  goPackage?: string;
  cgo?: boolean;
  // Rust
  binName?: string;
  // PHP
  docRoot?: string;
  laravel?: boolean;
  composer?: boolean;
  // Java
  javaTool?: "maven" | "gradle";
  wrapper?: boolean;
  // Ruby
  rubyVersion?: string;
  rails?: boolean;
  // Deno
  denoEntry?: string;
}

export interface DetectedStack {
  id: StackId;
  /** Human name of the language/runtime, e.g. "Python". */
  label: string;
  /** Framework, e.g. "FastAPI". */
  framework?: string;
  /** Files the detection is based on, e.g. "requirements.txt". */
  reason: string;
  /** Port the image listens on unless the platform sets PORT. */
  port: number;
  /** Default start command (a shell command; may use $PORT). */
  startCommand?: string;
  /** Default build command (Node: the package's build script). */
  buildCommand?: string;
  /** Hints shown in the deploy log (configuration the app probably needs). */
  notes: string[];
  plan: StackPlan;
}

export interface DockerfileOptions {
  /** The service's build command; replaces the stack default. */
  buildCommand?: string;
  /** The service's start command; replaces the stack default. */
  startCommand?: string;
  /** Default PORT baked into the image (the runner sets PORT at run time). */
  port: number;
  /** Node.js major for Node builds; replaces the detected one. */
  nodeMajor?: string;
  /** COPY `syncbay-build-ca.crt` from the context and trust it in every build stage. */
  extraCaCert?: boolean;
}

/** File name the runner copies `RUNNER_BUILD_CA_FILE` to inside the build context. */
export const BUILD_CA_FILE = "syncbay-build-ca.crt";
/** File name of the generated Dockerfile (never a user's file). */
export const GENERATED_DOCKERFILE = "Dockerfile.syncbay";
/** BuildKit reads `<Dockerfile>.dockerignore` before `.dockerignore`, so this never replaces the user's. */
export const GENERATED_DOCKERIGNORE = `${GENERATED_DOCKERFILE}.dockerignore`;
