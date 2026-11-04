-- Team C: shared simulated web-shell state (stateless control plane)

-- CreateTable
CREATE TABLE IF NOT EXISTS "terminal_sessions" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cwd" TEXT NOT NULL DEFAULT '/app',
    "envOverrides" JSONB NOT NULL DEFAULT '{}',
    "history" JSONB NOT NULL DEFAULT '[]',
    "buffer" TEXT NOT NULL DEFAULT '',
    "outputSeq" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "terminal_sessions_serviceId_idx" ON "terminal_sessions"("serviceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "terminal_sessions_lastActivityAt_idx" ON "terminal_sessions"("lastActivityAt");
