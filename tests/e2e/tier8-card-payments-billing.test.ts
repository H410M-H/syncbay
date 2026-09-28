/**
 * Syncbay PaaS — Tier 8 E2E Test Suite
 * Validates Credit/Debit Card Payment Options, PCI-DSS Tokenization,
 * Card Lifecycle Management, Invoice Settlement, and Prepaid Credits Top-Up.
 */

import {
  registerTest,
  assertTrue,
  assertFalse,
  assertEqual,
  assertIncludes,
  assertThrows,
} from "../harness";

import {
  luhnCheck,
  detectCardBrand,
  validateExpiry,
  validateCvc,
  validateCard,
  formatCardNumber,
  formatExpiry,
  getBrandMetadata,
  tokenizeCard,
  addPaymentMethod,
  listPaymentMethods,
  setDefaultPaymentMethod,
  deletePaymentMethod,
  executeCardCharge,
  addPrepaidCredits,
} from "../../src/lib/billing/payment-engine";

import { appRouter } from "../../src/server/root";

// ─── 1. CARD NUMBER VALIDATION & LUHN CHECKS ───────────────────────────────────

registerTest("PAY-01", "CARD_PAYMENTS", 8, "Luhn algorithm correctly validates valid and corrupt card numbers", () => {
  // Valid test card numbers
  assertTrue(luhnCheck("4111111111111111"), "Standard Visa test card should pass Luhn");
  assertTrue(luhnCheck("5555555555554444"), "Standard Mastercard test card should pass Luhn");
  assertTrue(luhnCheck("378282246310005"), "Standard Amex test card should pass Luhn");
  assertTrue(luhnCheck("6011111111111117"), "Standard Discover test card should pass Luhn");

  // Invalid card numbers
  assertFalse(luhnCheck("4111111111111112"), "Invalid Visa checksum should fail");
  assertFalse(luhnCheck("1234567812345671"), "Arbitrary invalid digits should fail");
  assertFalse(luhnCheck("123"), "Too short number should fail");
  assertFalse(luhnCheck(""), "Empty card number should fail");
});

registerTest("PAY-02", "CARD_PAYMENTS", 8, "Card brand detection accurately classifies Visa, Mastercard, Amex, Discover", () => {
  assertEqual(detectCardBrand("4111111111111111"), "visa");
  assertEqual(detectCardBrand("5105105105105100"), "mastercard");
  assertEqual(detectCardBrand("2221000000000000"), "mastercard"); // 2-series MC
  assertEqual(detectCardBrand("340000000000000"), "amex");
  assertEqual(detectCardBrand("370000000000000"), "amex");
  assertEqual(detectCardBrand("6011000000000000"), "discover");
  assertEqual(detectCardBrand("6500000000000000"), "discover");
  assertEqual(detectCardBrand("1234000000000000"), "unknown");
});

registerTest("PAY-03", "CARD_PAYMENTS", 8, "Expiry and CVC validation respects brand rules and calendar bounds", () => {
  const currentYear = new Date().getFullYear();
  const nextYear = currentYear + 2;

  // Expiry check
  assertTrue(validateExpiry(12, nextYear).isValid, "Future month and year should be valid");
  assertFalse(validateExpiry(13, nextYear).isValid, "Month 13 should be invalid");
  assertFalse(validateExpiry(0, nextYear).isValid, "Month 0 should be invalid");
  assertFalse(validateExpiry(1, 2020).isValid, "Past year 2020 should be expired");

  // CVC check: 3 digits for Visa/MC, 4 for Amex
  assertTrue(validateCvc("123", "visa").isValid, "3-digit CVC valid for Visa");
  assertFalse(validateCvc("1234", "visa").isValid, "4-digit CVC invalid for Visa");
  assertTrue(validateCvc("1234", "amex").isValid, "4-digit CVC valid for Amex");
  assertFalse(validateCvc("123", "amex").isValid, "3-digit CVC invalid for Amex");
});

registerTest("PAY-04", "CARD_PAYMENTS", 8, "Card formatting presents 4-4-4-4 grouping and 4-6-5 for Amex", () => {
  assertEqual(formatCardNumber("4111111111111111"), "4111 1111 1111 1111");
  assertEqual(formatCardNumber("378282246310005"), "3782 822463 10005");
  assertEqual(formatExpiry(5, 2028), "05/28");
});

// ─── 2. TOKENIZATION & PCI-DSS COMPLIANCE ──────────────────────────────────────

registerTest("PAY-05", "CARD_PAYMENTS", 8, "Tokenize card generates secure signature without retaining raw PAN or CVC", () => {
  const input = {
    cardNumber: "4111111111111111",
    expMonth: 10,
    expYear: 2028,
    cvc: "456",
    cardholderName: "Ada Lovelace",
    billingZip: "94104",
  };

  const tokenized = tokenizeCard(input);
  assertEqual(tokenized.brand, "visa");
  assertEqual(tokenized.last4, "1111");
  assertEqual(tokenized.cardholderName, "Ada Lovelace");
  assertTrue(tokenized.token.startsWith("pm_card_visa_1111_"), "Token must start with pm_card_ prefix");
  assertFalse(tokenized.token.includes("4111111111111111"), "Raw PAN must never be embedded in token");
  assertEqual((tokenized as any).cvc, undefined, "CVC must never be stored in tokenized payload");
});

// ─── 3. CARD LIFECYCLE & DATABASE OPERATIONS ───────────────────────────────────

function createMockBillingDb() {
  const paymentMethods: any[] = [];
  const auditLogs: any[] = [];
  const invoices: any[] = [];
  const workspaces: any[] = [
    {
      id: "ws-mock-1",
      name: "Acme Cloud Corp",
      creditBalanceCents: 5000, // $50.00
      spendingCapCents: 10000,
    },
  ];

  return {
    paymentMethod: {
      async count({ where }: any) {
        return paymentMethods.filter((pm) => pm.workspaceId === where.workspaceId).length;
      },
      async create({ data }: any) {
        const item = { id: `pm_${Date.now()}_${Math.random()}`, createdAt: new Date(), ...data };
        paymentMethods.push(item);
        return item;
      },
      async findMany({ where }: any) {
        return paymentMethods.filter((pm) => pm.workspaceId === where.workspaceId);
      },
      async findFirst({ where }: any) {
        return paymentMethods.find((pm) => {
          if (where.id && pm.id !== where.id) return false;
          if (where.workspaceId && pm.workspaceId !== where.workspaceId) return false;
          if (where.isDefault !== undefined && pm.isDefault !== where.isDefault) return false;
          return true;
        }) || null;
      },
      async update({ where, data }: any) {
        const idx = paymentMethods.findIndex((pm) => pm.id === where.id);
        if (idx !== -1) {
          paymentMethods[idx] = { ...paymentMethods[idx], ...data };
          return paymentMethods[idx];
        }
        throw new Error("Payment method not found");
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (let i = 0; i < paymentMethods.length; i++) {
          if (paymentMethods[i].workspaceId === where.workspaceId) {
            if (where.isDefault === undefined || paymentMethods[i].isDefault === where.isDefault) {
              paymentMethods[i] = { ...paymentMethods[i], ...data };
              count++;
            }
          }
        }
        return { count };
      },
      async delete({ where }: any) {
        const idx = paymentMethods.findIndex((pm) => pm.id === where.id);
        if (idx !== -1) {
          const deleted = paymentMethods.splice(idx, 1)[0];
          return deleted;
        }
        throw new Error("Payment method not found");
      },
    },
    auditLogEntry: {
      async create({ data }: any) {
        const log = { id: `audit_${Date.now()}`, createdAt: new Date(), ...data };
        auditLogs.push(log);
        return log;
      },
    },
    workspace: {
      async findUnique({ where }: any) {
        return workspaces.find((w) => w.id === where.id) || null;
      },
      async update({ where, data }: any) {
        const ws = workspaces.find((w) => w.id === where.id);
        if (ws) {
          if (data.creditBalanceCents?.increment) {
            ws.creditBalanceCents += data.creditBalanceCents.increment;
          }
          return ws;
        }
        throw new Error("Workspace not found");
      },
    },
    invoice: {
      async create({ data }: any) {
        const inv = { id: `inv_${Date.now()}_${Math.random()}`, createdAt: new Date(), ...data };
        invoices.push(inv);
        return inv;
      },
      async update({ where, data }: any) {
        const inv = invoices.find((i) => i.id === where.id);
        if (inv) {
          Object.assign(inv, data);
          return inv;
        }
        throw new Error("Invoice not found");
      },
      async findFirst({ where }: any) {
        return invoices.find((i) => i.id === where.id) || null;
      },
    },
    _rawState: { paymentMethods, auditLogs, invoices, workspaces },
  };
}

registerTest("PAY-06", "CARD_PAYMENTS", 8, "Adding first card automatically marks it as default", async () => {
  const db = createMockBillingDb();
  const card = await addPaymentMethod(
    db,
    "ws-mock-1",
    "user-1",
    {
      cardNumber: "4111111111111111",
      expMonth: 12,
      expYear: 2028,
      cvc: "123",
      cardholderName: "Alan Turing",
    },
    false // setAsDefault passed as false
  );

  assertTrue(card.isDefault, "First added card must automatically become default");
  assertEqual(card.brand, "visa");
  assertEqual(card.last4, "1111");
  assertEqual(db._rawState.auditLogs.length, 1);
  assertEqual(db._rawState.auditLogs[0].action, "billing.payment_method_added");
});

registerTest("PAY-07", "CARD_PAYMENTS", 8, "Setting a new default card updates previous default and audit log", async () => {
  const db = createMockBillingDb();

  // Add 1st card
  const c1 = await addPaymentMethod(db, "ws-mock-1", "user-1", {
    cardNumber: "4111111111111111",
    expMonth: 12,
    expYear: 2028,
    cvc: "123",
    cardholderName: "Alan Turing",
  });

  // Add 2nd card
  const c2 = await addPaymentMethod(db, "ws-mock-1", "user-1", {
    cardNumber: "5555555555554444",
    expMonth: 11,
    expYear: 2027,
    cvc: "789",
    cardholderName: "Alan Turing",
  });

  assertTrue(c1.isDefault);
  assertFalse(c2.isDefault);

  // Set 2nd card as default
  await setDefaultPaymentMethod(db, "ws-mock-1", "user-1", c2.id);

  const methods = await listPaymentMethods(db, "ws-mock-1");
  const updatedC1 = methods.find((m: any) => m.id === c1.id);
  const updatedC2 = methods.find((m: any) => m.id === c2.id);

  assertFalse(updatedC1.isDefault, "First card should no longer be default");
  assertTrue(updatedC2.isDefault, "Second card should now be default");
});

registerTest("PAY-08", "CARD_PAYMENTS", 8, "Deleting a default card auto-promotes newest remaining card to default", async () => {
  const db = createMockBillingDb();

  const c1 = await addPaymentMethod(db, "ws-mock-1", "user-1", {
    cardNumber: "4111111111111111",
    expMonth: 12,
    expYear: 2028,
    cvc: "123",
    cardholderName: "Grace Hopper",
  });

  const c2 = await addPaymentMethod(db, "ws-mock-1", "user-1", {
    cardNumber: "5555555555554444",
    expMonth: 11,
    expYear: 2027,
    cvc: "789",
    cardholderName: "Grace Hopper",
  });

  // c1 is default, delete c1
  await deletePaymentMethod(db, "ws-mock-1", "user-1", c1.id);

  const remaining = await listPaymentMethods(db, "ws-mock-1");
  assertEqual(remaining.length, 1);
  assertTrue(remaining[0].isDefault, "Remaining card should be auto-promoted to default");
});

// ─── 4. CHARGE EXECUTION & INVOICE SETTLEMENT ──────────────────────────────────

registerTest("PAY-09", "CARD_PAYMENTS", 8, "Execute card charge generates valid transaction, auth code, and receipt", async () => {
  const db = createMockBillingDb();

  await addPaymentMethod(db, "ws-mock-1", "user-1", {
    cardNumber: "4111111111111111",
    expMonth: 12,
    expYear: 2028,
    cvc: "123",
    cardholderName: "Barbara Liskov",
  });

  const charge = await executeCardCharge(db, "ws-mock-1", "user-1", {
    amountCents: 2500, // $25.00
    description: "Syncbay Pro Monthly Subscription",
  });

  assertTrue(charge.success);
  assertTrue(charge.transactionId.startsWith("ch_sb_visa_"));
  assertTrue(charge.authorizationCode.startsWith("AUTH_"));
  assertTrue(charge.receiptNumber.startsWith("REC-SB-"));
  assertEqual(charge.amountCents, 2500);
  assertEqual(charge.last4, "1111");
});

registerTest("PAY-10", "CARD_PAYMENTS", 8, "Card ending in 0002 simulates realistic payment issuer decline", async () => {
  const db = createMockBillingDb();

  // Test card ending in 0002
  await addPaymentMethod(db, "ws-mock-1", "user-1", {
    cardNumber: "4000000000000002",
    expMonth: 10,
    expYear: 2028,
    cvc: "999",
    cardholderName: "Decline Tester",
  });

  let declined = false;
  try {
    await executeCardCharge(db, "ws-mock-1", "user-1", {
      amountCents: 1000,
      description: "Test charge",
    });
  } catch (err: any) {
    declined = true;
    assertIncludes(err.message, "declined");
  }

  assertTrue(declined, "Card ending in 0002 must trigger issuer decline error");
});

registerTest("PAY-11", "CARD_PAYMENTS", 8, "Prepaid credits purchase increments workspace balance and records invoice", async () => {
  const db = createMockBillingDb();

  await addPaymentMethod(db, "ws-mock-1", "user-1", {
    cardNumber: "4111111111111111",
    expMonth: 12,
    expYear: 2028,
    cvc: "123",
    cardholderName: "Tim Berners-Lee",
  });

  const initialBalance = db._rawState.workspaces[0].creditBalanceCents; // 5000 cents ($50)

  const result = await addPrepaidCredits(db, "ws-mock-1", "user-1", 2500); // +$25.00

  assertEqual(result.newBalanceCents, initialBalance + 2500);
  assertEqual(result.invoice.status, "PAID");
  assertEqual(result.invoice.amountCents, 2500);
  assertTrue(result.charge.receiptNumber.length > 0);
});

registerTest("PAY-12", "CARD_PAYMENTS", 8, "Root tRPC router includes billing sub-router with all procedures", () => {
  assertTrue(!!(appRouter._def.record as any).billing, "billingRouter must be registered on appRouter");

  const billingProcedures = (appRouter._def.record as any).billing;
  assertTrue(!!billingProcedures.listPaymentMethods, "listPaymentMethods procedure exists");
  assertTrue(!!billingProcedures.addCard, "addCard procedure exists");
  assertTrue(!!billingProcedures.setDefaultCard, "setDefaultCard procedure exists");
  assertTrue(!!billingProcedures.removeCard, "removeCard procedure exists");
  assertTrue(!!billingProcedures.addCredits, "addCredits procedure exists");
  assertTrue(!!billingProcedures.payInvoice, "payInvoice procedure exists");
  assertTrue(!!billingProcedures.listInvoices, "listInvoices procedure exists");
  assertTrue(!!billingProcedures.getBillingSummary, "getBillingSummary procedure exists");
});
