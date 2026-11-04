/**
 * Syncbay — Billing tRPC router (Stripe).
 *
 * No procedure accepts card data. Every input schema is strict, so a request
 * carrying unexpected keys (e.g. a card number or CVC) is rejected outright
 * instead of being silently stripped. Cards are added through a SetupIntent
 * confirmed by Stripe Elements in the browser.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import {
  BillingError,
  MAX_TOP_UP_CENTS,
  MIN_TOP_UP_CENTS,
  completeSetupIntent,
  createSetupIntent,
  createTopUp,
  deletePaymentMethod,
  listPaymentMethods,
  payInvoice,
  setDefaultPaymentMethod,
  syncTopUp,
} from "@/lib/billing/payment-engine";
import { StripeNotConfiguredError, getPublicStripeConfig, getStripe, requireStripe } from "@/lib/billing/stripe-client";

async function assertMember(db: PrismaClient, userId: string, workspaceId: string) {
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!member) throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this workspace" });
  return member;
}

/** Asserts the caller is an OWNER or ADMIN of the workspace. */
async function assertBillingAccess(db: PrismaClient, userId: string, workspaceId: string) {
  const member = await assertMember(db, userId, workspaceId);
  if (member.role !== "OWNER" && member.role !== "ADMIN") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can manage payment methods and billing",
    });
  }
  return member;
}

/** Maps engine / Stripe errors to tRPC errors without leaking provider internals. */
function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof StripeNotConfiguredError) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  if (err instanceof BillingError) {
    return new TRPCError({ code: err.code, message: err.message });
  }
  const e = err as { type?: string; message?: string; code?: string };
  if (e?.type === "StripeCardError") {
    return new TRPCError({ code: "BAD_REQUEST", message: e.message || "Your card was declined." });
  }
  if (e?.type === "StripeInvalidRequestError" && e.code === "resource_missing") {
    return new TRPCError({ code: "NOT_FOUND", message: "Payment object not found in Stripe" });
  }
  console.error("[billing] provider error:", e?.type, e?.code, e?.message);
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Payment provider error. Please try again." });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

const workspaceInput = z.object({ workspaceId: z.string().min(1) }).strict();

export const billingRouter = createTRPCRouter({
  /** Whether Stripe is configured, and the publishable key for Stripe Elements. */
  getConfig: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await assertMember(ctx.db, ctx.session.user.id, input.workspaceId);
    return getPublicStripeConfig();
  }),

  /** Saved cards, listed from Stripe (empty when Stripe is not configured). */
  listPaymentMethods: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await assertMember(ctx.db, ctx.session.user.id, input.workspaceId);
    const stripe = getStripe();
    if (!stripe) return [];
    return guard(() => listPaymentMethods(ctx.db, stripe, input.workspaceId));
  }),

  /** Step 1 of adding a card: a SetupIntent whose client secret feeds Stripe Elements. */
  createSetupIntent: protectedProcedure.input(workspaceInput).mutation(async ({ ctx, input }) => {
    await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);
    return guard(() => createSetupIntent(ctx.db, requireStripe(), input.workspaceId, ctx.session.user.id));
  }),

  /** Step 2: after `stripe.confirmSetup()` succeeds in the browser, record the card Stripe saved. */
  confirmSetupIntent: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().min(1),
          setupIntentId: z.string().regex(/^seti_[A-Za-z0-9]+$/, "Invalid SetupIntent id"),
          setAsDefault: z.boolean().default(false),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);
      return guard(() =>
        completeSetupIntent(ctx.db, requireStripe(), {
          workspaceId: input.workspaceId,
          userId: ctx.session.user.id,
          setupIntentId: input.setupIntentId,
          setAsDefault: input.setAsDefault,
        })
      );
    }),

  setDefaultCard: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), paymentMethodId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);
      return guard(() =>
        setDefaultPaymentMethod(ctx.db, requireStripe(), input.workspaceId, ctx.session.user.id, input.paymentMethodId)
      );
    }),

  removeCard: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), paymentMethodId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);
      return guard(() =>
        deletePaymentMethod(ctx.db, requireStripe(), input.workspaceId, ctx.session.user.id, input.paymentMethodId)
      );
    }),

  /** Starts a prepaid credit top-up (PaymentIntent). Credits are granted once Stripe reports success. */
  createTopUp: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().min(1),
          amountCents: z.number().int().min(MIN_TOP_UP_CENTS).max(MAX_TOP_UP_CENTS),
          paymentMethodId: z.string().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);
      return guard(() =>
        createTopUp(ctx.db, requireStripe(), {
          workspaceId: input.workspaceId,
          userId: ctx.session.user.id,
          amountCents: input.amountCents,
          paymentMethodId: input.paymentMethodId,
        })
      );
    }),

  /** Re-reads a top-up's PaymentIntent from Stripe (after client-side confirmation). */
  syncTopUp: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), invoiceId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);
      return guard(() => syncTopUp(ctx.db, requireStripe(), input.workspaceId, input.invoiceId));
    }),

  /** Pays an issued monthly usage invoice through Stripe. */
  payInvoice: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().min(1),
          invoiceId: z.string().min(1),
          paymentMethodId: z.string().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);
      return guard(() =>
        payInvoice(ctx.db, requireStripe(), {
          workspaceId: input.workspaceId,
          userId: ctx.session.user.id,
          invoiceId: input.invoiceId,
          paymentMethodId: input.paymentMethodId,
        })
      );
    }),

  listInvoices: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await assertMember(ctx.db, ctx.session.user.id, input.workspaceId);
    return ctx.db.invoice.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: { createdAt: "desc" },
    });
  }),

  /** Billing overview (balance, default card, recent invoices). Members only. */
  getBillingSummary: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await assertMember(ctx.db, ctx.session.user.id, input.workspaceId);
    const workspace = await ctx.db.workspace.findUnique({
      where: { id: input.workspaceId },
      include: {
        paymentMethods: { orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] },
        invoices: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });
    if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });

    const stripe = getPublicStripeConfig();
    // Without Stripe there are no real saved cards; never surface legacy local rows.
    const cards = stripe.mode === "unconfigured" ? [] : workspace.paymentMethods.filter((pm) => !!pm.stripePaymentMethodId);
    const defaultCard = cards.find((pm) => pm.isDefault) || cards[0] || null;

    return {
      stripe,
      creditBalanceCents: workspace.creditBalanceCents,
      spendingCapCents: workspace.spendingCapCents,
      cardsCount: cards.length,
      defaultCard,
      recentInvoices: workspace.invoices,
      unpaidInvoicesCount: workspace.invoices.filter((inv) => inv.status === "OPEN" || inv.status === "PAST_DUE").length,
    };
  }),
});
