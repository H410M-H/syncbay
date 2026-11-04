/**
 * Browser-safe display helpers for saved Stripe card payment methods.
 * Only brand / last4 / expiry returned by Stripe are ever rendered.
 */

export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "unknown";

export function formatExpiry(month: number, year: number): string {
  const mm = String(month).padStart(2, "0");
  const yy = String(year).slice(-2);
  return `${mm}/${yy}`;
}

export function getBrandMetadata(brand: string): { name: string; color: string } {
  switch (brand as CardBrand) {
    case "visa":
      return { name: "Visa", color: "#2563eb" };
    case "mastercard":
      return { name: "Mastercard", color: "#ea580c" };
    case "amex":
      return { name: "American Express", color: "#0284c7" };
    case "discover":
      return { name: "Discover", color: "#d97706" };
    default:
      return { name: brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Card", color: "#64748b" };
  }
}
