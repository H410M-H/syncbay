-- Services run around the clock unless their owner opts into scale-to-zero.
ALTER TABLE "services" ALTER COLUMN "scaleToZero" SET DEFAULT false;
ALTER TABLE "services" ALTER COLUMN "idleTimeoutSecs" SET DEFAULT 1800;

-- Existing services were created with the old default (sleep after 5 idle minutes).
-- PR preview environments keep scale-to-zero: they are meant to sleep.
UPDATE "services" AS s
SET "scaleToZero" = false
FROM "environments" AS e
WHERE e."id" = s."environmentId"
  AND e."isPrEnv" = false
  AND s."scaleToZero" = true;

-- "services"."port" is the port the app listens on inside its container. Older engines
-- overwrote it with the host port a runner had assigned (10000-60000), which then became the
-- container port of the next deploy. Clear those values; the runner detects the app's port
-- and the engine stores it again. The live host port is "deployments"."assignedPort".
UPDATE "services" SET "port" = NULL WHERE "port" >= 10000;
