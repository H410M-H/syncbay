/**
 * Syncbay PaaS — syncbay.json / syncbay.yml Manifest Engine (M6 Core)
 * Parses, validates, and transforms infrastructure-as-code manifests into deployment plans.
 */

import { z } from "zod";

export const ServiceManifestSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  source: z
    .object({
      git: z.string().optional(),
      branch: z.string().default("main"),
      rootDir: z.string().optional(),
      dockerfile: z.string().optional(),
      image: z.string().optional(),
    })
    .default({ branch: "main" }),
  build: z
    .object({
      command: z.string().optional(),
      nixpacks: z.boolean().default(true),
    })
    .optional(),
  run: z
    .object({
      command: z.string().optional(),
      port: z.number().int().min(1).max(65535).default(3000),
    })
    .default({ command: undefined, port: 3000 }),
  env: z.record(z.string(), z.string()).default({}),
  healthcheck: z
    .object({
      path: z.string().default("/health"),
      timeoutSecs: z.number().int().default(15),
      intervalSecs: z.number().int().default(10),
    })
    .default({ path: "/health", timeoutSecs: 15, intervalSecs: 10 }),
  regions: z.array(z.string()).default(["iad1"]),
  scaling: z
    .object({
      instanceType: z.string().default("lite"),
      minReplicas: z.number().int().default(1),
      maxReplicas: z.number().int().default(5),
      scaleToZero: z.boolean().default(false),
    })
    .default({
      instanceType: "lite",
      minReplicas: 1,
      maxReplicas: 5,
      scaleToZero: false,
    }),
});

export const DatabaseManifestSchema = z.object({
  name: z.string().min(1).max(64),
  provider: z.enum(["POSTGRES", "REDIS", "MYSQL"]).default("POSTGRES"),
  storageGb: z.number().int().default(1),
  backupRetainDays: z.number().int().default(7),
});

export const StorageManifestSchema = z.object({
  name: z.string().min(1).max(64),
  corsEnabled: z.boolean().default(true),
});

export const SyncbayManifestSchema = z.object({
  version: z.literal("1").or(z.literal("1.0")),
  project: z.string().min(1).max(64),
  services: z.array(ServiceManifestSchema).min(1),
  databases: z.array(DatabaseManifestSchema).default([]),
  storage: z.array(StorageManifestSchema).default([]),
});

export type SyncbayManifest = z.infer<typeof SyncbayManifestSchema>;
type ServiceManifest = z.infer<typeof ServiceManifestSchema>;

/**
 * Parses and validates a JSON or YAML-like manifest object
 */
export function parseManifest(rawJson: string | object): SyncbayManifest {
  let parsed: any;
  if (typeof rawJson === "string") {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error("Invalid manifest: Expected valid JSON format");
    }
  } else {
    parsed = rawJson;
  }

  const result = SyncbayManifestSchema.safeParse(parsed);
  if (!result.success) {
    const errorDetails = (result.error.issues || [])
      .map((e: any) => `${e.path.join(".")}: ${e.message}`)
      .join(", ") || result.error.message;
    throw new Error(`Manifest validation failed: ${errorDetails}`);
  }

  return result.data;
}

/**
 * Generates a default starter `syncbay.json` manifest
 */
export function generateStarterManifest(projectName: string = "my-syncbay-app"): SyncbayManifest {
  return {
    version: "1",
    project: projectName,
    services: [
      {
        name: "web",
        source: {
          branch: "main",
        },
        run: {
          port: 3000,
        },
        env: {
          NODE_ENV: "production",
          DATABASE_URL: "${{ Postgres.URL }}",
        },
        healthcheck: {
          path: "/health",
          timeoutSecs: 15,
          intervalSecs: 10,
        },
        regions: ["iad1", "fra1"],
        scaling: {
          instanceType: "lite",
          minReplicas: 1,
          maxReplicas: 3,
          scaleToZero: true,
        },
      },
    ],
    databases: [
      {
        name: "main-db",
        provider: "POSTGRES",
        storageGb: 5,
        backupRetainDays: 7,
      },
    ],
    storage: [
      {
        name: "media-bucket",
        corsEnabled: true,
      },
    ],
  };
}

/**
 * Generates a production GitHub Actions CI/CD workflow YAML
 */
export function generateGitHubWorkflow(projectName: string): string {
  return `name: Syncbay Continuous Delivery

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy:
    name: Build & Deploy to Syncbay Edge
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Deploy to Syncbay PaaS
        env:
          SYNCBAY_API_TOKEN: \${{ secrets.SYNCBAY_API_TOKEN }}
          SYNCBAY_PROJECT: "${projectName}"
        run: |
          npx syncbay deploy --token "\$SYNCBAY_API_TOKEN" --project "\$SYNCBAY_PROJECT" --env "\${{ github.ref == 'refs/heads/main' && 'production' || 'preview' }}"
`;
}
