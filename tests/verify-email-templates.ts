/**
 * Syncbay — React Email template smoke test.
 *
 * Renders every transactional template with `render` (re-exported by
 * @react-email/components from @react-email/render) and asserts that each one
 * produces a non-empty HTML document carrying the Syncbay brand.
 */

import { createElement, type ComponentType, type ReactElement } from "react";
import { render } from "@react-email/components";
import { WelcomeEmail } from "../src/lib/email/templates/welcome";
import { InvitationEmail } from "../src/lib/email/templates/invitation";
import { DeploymentNotificationEmail } from "../src/lib/email/templates/deployment-notification";
import { PasswordResetEmail } from "../src/lib/email/templates/password-reset";
import { BillingAlertEmail } from "../src/lib/email/templates/billing-alert";
import { UsageWarningEmail } from "../src/lib/email/templates/usage-warning";

type Case = { name: string; element: () => ReactElement };

// Typed per template so a props change in a template breaks this test at type-check time.
function defineCase<P extends object>(name: string, component: ComponentType<P>, props: P): Case {
  return { name, element: () => createElement(component, props) };
}

const cases: Case[] = [
  defineCase("welcome", WelcomeEmail, { name: "Ada", loginUrl: "https://syncbay.app/login" }),
  defineCase("invitation", InvitationEmail, {
    inviterName: "Ada",
    inviteeEmail: "grace@example.com",
    teamName: "Analytical Engines",
    acceptUrl: "https://syncbay.app/invite/token",
  }),
  defineCase("deployment-notification", DeploymentNotificationEmail, {
    projectName: "web",
    status: "failure",
    deploymentUrl: "https://web.syncbay.app",
    commitMessage: "feat: ship it",
    commitHash: "abc1234",
    errorLog: "Error: build failed",
  }),
  defineCase("password-reset", PasswordResetEmail, {
    userEmail: "ada@example.com",
    resetUrl: "https://syncbay.app/reset/token",
  }),
  defineCase("billing-alert", BillingAlertEmail, {
    amount: "$20.00",
    invoiceUrl: "https://syncbay.app/billing/invoices/1",
    description: "Syncbay Pro Plan - Monthly",
    date: "2026-11-01",
  }),
  defineCase("usage-warning", UsageWarningEmail, {
    percentage: 85,
    metricName: "Build minutes",
    limit: "1000 min",
    currentUsage: "850 min",
    upgradeUrl: "https://syncbay.app/billing",
  }),
];

async function main() {
  let failures = 0;
  for (const { name, element } of cases) {
    try {
      const html = await render(element());
      if (!html || html.trim().length === 0) throw new Error("rendered HTML is empty");
      if (!/<html/i.test(html)) throw new Error("rendered output has no <html> element");
      if (!/Syncbay|Syncbay/.test(html)) throw new Error('rendered HTML does not mention "Syncbay"');
      console.log(`  PASS  ${name} (${html.length} bytes)`);
    } catch (error) {
      failures++;
      console.error(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures}/${cases.length} email templates failed to render`);
    process.exit(1);
  }
  console.log(`\nAll ${cases.length} email templates rendered`);
}

void main();
