import { ABUSE_CATEGORIES, type AbuseCategory } from "@/lib/admin/permissions";

/** Human labels for the abuse categories (public form and moderation queue). */
export const ABUSE_CATEGORY_LABELS: Record<AbuseCategory, string> = {
  CSAM: "Child sexual abuse material (CSAM)",
  PHISHING: "Phishing or credential theft",
  MALWARE: "Malware or malicious downloads",
  FRAUD: "Fraud or scam",
  CRYPTO_MINING: "Unauthorized crypto mining",
  ILLEGAL: "Other illegal content",
  SPAM: "Spam",
  COPYRIGHT: "Copyright or trademark infringement",
  OTHER: "Something else",
};

export const ABUSE_CATEGORY_IDS = Object.keys(ABUSE_CATEGORIES) as AbuseCategory[];

export function abuseCategoryLabel(id: string): string {
  return (ABUSE_CATEGORY_LABELS as Record<string, string>)[id] ?? id;
}

export const NCMEC_REPORT_URL = "https://report.cybertip.org";
