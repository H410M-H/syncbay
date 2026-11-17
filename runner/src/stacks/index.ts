/**
 * Syncbay stack templates: detect a project's language/framework from its manifests and generate
 * a Dockerfile for it, so common stacks build without a customer Dockerfile. Pure functions only;
 * the runner pipeline (`../pipeline.ts`) does the file I/O.
 */

export { detectStack, cargoBinName, pyprojectDependencies } from "./detect.ts";
export { generateDockerfile, generateDockerignore } from "./dockerfile.ts";
export { BUILD_CA_FILE, GENERATED_DOCKERFILE, GENERATED_DOCKERIGNORE } from "./types.ts";
export type { DetectedStack, StackFiles } from "./types.ts";
