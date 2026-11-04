-- Team D: Stripe billing (PaymentIntents, SetupIntents, Invoices, webhook idempotency)

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InvoiceKind') THEN
        CREATE TYPE "InvoiceKind" AS ENUM ('USAGE', 'TOP_UP');
    END IF;
END $$;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "creditAppliedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "description" TEXT,
ADD COLUMN IF NOT EXISTS "failureMessage" TEXT,
ADD COLUMN IF NOT EXISTS "kind" "InvoiceKind" NOT NULL DEFAULT 'USAGE',
ADD COLUMN IF NOT EXISTS "lineItems" JSONB,
ADD COLUMN IF NOT EXISTS "periodKey" TEXT,
ADD COLUMN IF NOT EXISTS "stripePaymentIntentId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stripe_events_type_idx" ON "stripe_events"("type");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_stripeCustomerId_key" ON "workspaces"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_stripePaymentIntentId_key" ON "invoices"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_workspaceId_periodKey_key" ON "invoices"("workspaceId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payment_methods_stripePaymentMethodId_key" ON "payment_methods"("stripePaymentMethodId");
