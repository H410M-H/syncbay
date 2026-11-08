import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Syncbay PaaS Public API",
      version: "1.0.0",
      description:
        "Public REST API for automating deployments, managing services, and querying infrastructure on the Syncbay Cloud Hyper-Plane.",
      contact: {
        name: "Syncbay Platform Engineering",
        url: "https://www.syncbay.app",
      },
    },
    servers: [
      {
        url: "https://www.syncbay.app/api/v1",
        description: "Production Edge Cloud",
      },
      {
        url: "http://localhost:3000/api/v1",
        description: "Local Development Server",
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Token (pw_live_... / sb_live_...)",
          description: "Enter your Syncbay Workspace API Token with appropriate scope.",
        },
      },
      schemas: {
        Project: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Service: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            sourceType: { type: "string" },
            branch: { type: "string", nullable: true },
            instanceType: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Deployment: {
          type: "object",
          properties: {
            id: { type: "string" },
            serviceId: { type: "string" },
            status: {
              type: "string",
              enum: ["QUEUED", "BUILDING", "DEPLOYING", "ACTIVE", "FAILED", "CRASHED", "SLEEPING"],
            },
            startedAt: { type: "string", format: "date-time", nullable: true },
            completedAt: { type: "string", format: "date-time", nullable: true },
          },
        },
      },
    },
    security: [{ BearerAuth: [] }],
    paths: {
      "/projects": {
        get: {
          summary: "List Workspace Projects",
          description: "Retrieve all projects belonging to the authenticated workspace.",
          responses: {
            200: { description: "List of projects returned successfully" },
            401: { description: "Unauthorized or invalid API token" },
          },
        },
        post: {
          summary: "Create Project",
          description: "Creates a new project within the authenticated workspace.",
          responses: {
            201: { description: "Project created successfully" },
            400: { description: "Invalid project parameters" },
            403: { description: "Token lacks write scope" },
            409: { description: "A project with this name already exists in the workspace (existingProjectId)" },
          },
        },
      },
      "/services": {
        get: {
          summary: "List Project Services",
          parameters: [
            {
              name: "projectId",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Services returned" },
          },
        },
        post: {
          summary: "Create Service",
          responses: {
            201: { description: "Service created" },
          },
        },
      },
      "/deployments": {
        get: {
          summary: "List Service Deployments",
          parameters: [
            {
              name: "serviceId",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Deployments returned" },
          },
        },
        post: {
          summary: "Trigger New Deployment",
          description: "Dispatches an asynchronous build and edge deployment pipeline.",
          responses: {
            202: { description: "Deployment queued and triggered" },
            403: { description: "Token lacks DEPLOY_ONLY or FULL_ACCESS scope" },
            412: { description: "Runner not configured (code RUNNER_NOT_CONFIGURED); the error says what to set. No deployment is created" },
          },
        },
      },
      "/databases": {
        get: {
          summary: "List Managed Databases",
          responses: {
            200: { description: "Databases returned" },
          },
        },
        post: {
          summary: "Provision Database",
          responses: {
            201: { description: "Database provisioned" },
          },
        },
      },
    },
  };

  return NextResponse.json(spec, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
