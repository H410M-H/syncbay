/**
 * Syncbay PaaS — Billing & Payment Methods tRPC Router
 * Manages credit/debit card registration, default card selection,
 * invoice payments, and prepaid cloud compute credits top-up.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";
import { TRPCError } from "@trpc/server";
import {
  addPaymentMethod,
  listPaymentMethods,
  setDefaultPaymentMethod,
  deletePaymentMethod,
  executeCardCharge,
  addPrepaidCredits,
  validateCard,
} from "@/lib/billing/payment-engine";

/**
 * Asserts caller is an OWNER or ADMIN of the workspace
 */
async function assertBillingAccess(db: any, userId: string, workspaceId: string) {
  const membership = await db.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
  });

  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can manage payment methods and billing",
    });
  }

  return membership;
}

export const billingRouter = createTRPCRouter({
  /**
   * List all saved payment cards for a workspace
   */
  listPaymentMethods: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      // Any workspace member can view payment cards summary (masked)
      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });

      return listPaymentMethods(ctx.db, input.workspaceId);
    }),

  /**
   * Register a new credit or debit card
   */
  addCard: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        cardNumber: z.string(),
        expMonth: z.number().int().min(1).max(12),
        expYear: z.number().int(),
        cvc: z.string(),
        cardholderName: z.string(),
        billingZip: z.string().optional(),
        billingCountry: z.string().optional(),
        setAsDefault: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);

      try {
        return await addPaymentMethod(
          ctx.db,
          input.workspaceId,
          ctx.session.user.id,
          {
            cardNumber: input.cardNumber,
            expMonth: input.expMonth,
            expYear: input.expYear,
            cvc: input.cvc,
            cardholderName: input.cardholderName,
            billingZip: input.billingZip,
            billingCountry: input.billingCountry,
          },
          input.setAsDefault
        );
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.message || "Failed to add payment card",
        });
      }
    }),

  /**
   * Set a saved card as the default payment method
   */
  setDefaultCard: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        paymentMethodId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);

      try {
        return await setDefaultPaymentMethod(
          ctx.db,
          input.workspaceId,
          ctx.session.user.id,
          input.paymentMethodId
        );
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.message || "Failed to update default card",
        });
      }
    }),

  /**
   * Remove a saved card
   */
  removeCard: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        paymentMethodId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);

      try {
        return await deletePaymentMethod(
          ctx.db,
          input.workspaceId,
          ctx.session.user.id,
          input.paymentMethodId
        );
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.message || "Failed to remove card",
        });
      }
    }),

  /**
   * Purchase prepaid cloud compute credits using saved card
   */
  addCredits: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        amountCents: z.number().int().min(500), // Min $5.00
        paymentMethodId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);

      try {
        return await addPrepaidCredits(
          ctx.db,
          input.workspaceId,
          ctx.session.user.id,
          input.amountCents,
          input.paymentMethodId
        );
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.message || "Failed to purchase cloud credits",
        });
      }
    }),

  /**
   * Pay an open invoice with a card
   */
  payInvoice: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        invoiceId: z.string(),
        paymentMethodId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertBillingAccess(ctx.db, ctx.session.user.id, input.workspaceId);

      const invoice = await ctx.db.invoice.findFirst({
        where: { id: input.invoiceId, workspaceId: input.workspaceId },
      });

      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      }

      if (invoice.status === "PAID") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice is already paid" });
      }

      try {
        return await executeCardCharge(ctx.db, input.workspaceId, ctx.session.user.id, {
          amountCents: invoice.amountCents,
          description: `Invoice settlement #${invoice.id.slice(0, 8)}`,
          paymentMethodId: input.paymentMethodId,
          invoiceId: invoice.id,
        });
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err.message || "Failed to charge card for invoice",
        });
      }
    }),

  /**
   * List invoices for a workspace
   */
  listInvoices: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const member = await ctx.db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: ctx.session.user.id,
          },
        },
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });

      return ctx.db.invoice.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: { createdAt: "desc" },
      });
    }),

  /**
   * Get billing overview summary (balance, cards, recent invoice)
   */
  getBillingSummary: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const workspace = await ctx.db.workspace.findUnique({
        where: { id: input.workspaceId },
        include: {
          paymentMethods: {
            orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
          },
          invoices: {
            orderBy: { createdAt: "desc" },
            take: 5,
          },
        },
      });

      if (!workspace) throw new TRPCError({ code: "NOT_FOUND" });

      const defaultCard = workspace.paymentMethods.find((pm: any) => pm.isDefault) || workspace.paymentMethods[0] || null;
      const unpaidInvoices = workspace.invoices.filter((inv: any) => inv.status === "OPEN");

      return {
        creditBalanceCents: workspace.creditBalanceCents,
        spendingCapCents: workspace.spendingCapCents,
        cardsCount: workspace.paymentMethods.length,
        defaultCard,
        recentInvoices: workspace.invoices,
        unpaidInvoicesCount: unpaidInvoices.length,
      };
    }),
});
