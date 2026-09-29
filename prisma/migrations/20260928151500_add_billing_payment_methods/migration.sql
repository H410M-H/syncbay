-- AlterEnum
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'ADMIN';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "creditBalanceCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "paymentMethodId" TEXT,
ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "payment_methods" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "expMonth" INTEGER NOT NULL,
    "expYear" INTEGER NOT NULL,
    "cardholderName" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "stripePaymentMethodId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_methods_workspaceId_idx" ON "payment_methods"("workspaceId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payment_methods_workspaceId_fkey'
    ) THEN
        ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
