-- One-click templates: health-check path from syncbay.json, Postgres extensions (pgvector)
ALTER TABLE "services" ADD COLUMN "healthCheckUrl" TEXT;
ALTER TABLE "database_instances" ADD COLUMN "extensions" TEXT[] DEFAULT ARRAY[]::TEXT[];
