import type { Metadata } from "next";
import Link from "next/link";
import { ReportAbuseForm } from "./report-form";

export const metadata: Metadata = {
  title: "Report abuse",
  description: "Report phishing, malware, fraud, spam or other abuse hosted on Syncbay.",
};

/** Public abuse report form (no login). Posts to `POST /api/v1/abuse`. */
export default function ReportAbusePage() {
  return (
    <main style={{ minHeight: "100dvh", display: "flex", justifyContent: "center", padding: "48px 16px" }}>
      <div style={{ width: "100%", maxWidth: "640px" }}>
        <Link href="/" style={{ color: "var(--text-secondary)", fontSize: "0.875rem", textDecoration: "none" }}>
          ← Syncbay
        </Link>
        <h1 className="page-title" style={{ marginTop: "16px" }}>
          Report abuse
        </h1>
        <p className="page-subtitle" style={{ marginBottom: "24px", lineHeight: 1.6 }}>
          Tell us about phishing, malware, fraud, spam or other abuse on a site hosted by Syncbay. You do not need an account. Our trust &amp; safety team reviews
          every report; urgent categories first.
        </p>
        <ReportAbuseForm />
        <p style={{ marginTop: "20px", color: "var(--text-muted)", fontSize: "0.8125rem", lineHeight: 1.6 }}>
          You can also email <a href="mailto:abuse@syncbay.app">abuse@syncbay.app</a>. For copyright notices, include the work and your contact details.
        </p>
      </div>
    </main>
  );
}
