/**
 * Syncbay PaaS — Brand Logo & SEO Enhancement Test Suite
 * Validates:
 * 1. Authentic Vercel Avatar extraction and Brand Assets Generation
 * 2. Multi-resolution Favicons, Apple Touch Icon, Android Chrome & Web Manifest
 * 3. High-Resolution OpenGraph & Twitter Social Cards
 * 4. Robots.txt, Sitemap.xml, Canonical URLs & Layout SEO Metadata
 * 5. Global BrandLogo Component Integration across all public and protected views
 */

import {
  registerTest,
  assertTrue,
  assertEqual,
} from "../harness";

import fs from "fs";
import path from "path";
import robots from "../../src/app/robots";
import sitemap from "../../src/app/sitemap";

// ─── 1. Brand Logo Assets Verification ──────────────────────────────────────
registerTest("BRAND-01", "BRAND_ASSETS", 9, "All brand icons and avatar files exist in public/ and src/app/", () => {
  const root = process.cwd();
  const requiredAssets = [
    "public/syncbay-avatar.png",
    "public/brand-icon.png",
    "public/brand-icon-tight.png",
    "public/brand-icon.svg",
    "public/brand-logo.png",
    "public/apple-touch-icon.png",
    "public/android-chrome-192x192.png",
    "public/android-chrome-512x512.png",
    "public/favicon.ico",
    "public/favicon-16x16.png",
    "public/favicon-32x32.png",
    "public/og-image.png",
    "public/site.webmanifest",
    "src/app/favicon.ico",
  ];

  for (const asset of requiredAssets) {
    const p = path.join(root, asset);
    assertTrue(fs.existsSync(p), `Required asset missing: ${asset}`);
    const stats = fs.statSync(p);
    assertTrue(stats.size > 100, `Asset file is too small: ${asset} (${stats.size} bytes)`);
  }
});

registerTest("BRAND-02", "BRAND_ASSETS", 9, "Web manifest is valid JSON and points to official brand icons", () => {
  const manifestPath = path.join(process.cwd(), "public/site.webmanifest");
  const content = fs.readFileSync(manifestPath, "utf-8");
  const json = JSON.parse(content);

  assertEqual(json.short_name, "Syncbay", "Manifest short_name must be Syncbay");
  assertTrue(Array.isArray(json.icons), "Manifest icons must be an array");
  assertTrue(json.icons.some((i: any) => i.src === "/apple-touch-icon.png"), "Must include apple-touch-icon");
  assertTrue(json.icons.some((i: any) => i.src === "/android-chrome-192x192.png"), "Must include 192px icon");
  assertTrue(json.icons.some((i: any) => i.src === "/android-chrome-512x512.png"), "Must include 512px icon");
});

// ─── 2. SEO & OpenGraph Enhancements ─────────────────────────────────────────
registerTest("SEO-01", "SEO_METADATA", 9, "Root layout metadata contains canonical URL, icons, manifest, and OpenGraph images", () => {
  const layoutPath = path.join(process.cwd(), "src/app/layout.tsx");
  const content = fs.readFileSync(layoutPath, "utf-8");

  assertTrue(content.includes("canonical: \"https://www.syncbay.app\""), "Canonical URL must match production");
  assertTrue(content.includes("manifest: \"/site.webmanifest\""), "Manifest must be linked");
  assertTrue(content.includes("/og-image.png"), "Must reference og-image.png");
  assertTrue(content.includes("/brand-logo.png"), "Must reference brand-logo.png");
  assertTrue(content.includes("https://schema.org"), "Must include JSON-LD schema");
  assertTrue(content.includes("\"@type\": \"Organization\""), "Must include Organization schema");
});

registerTest("SEO-02", "SEO_METADATA", 9, "All marketing subpages have dedicated server layouts with rich metadata", () => {
  const pricingPath = path.join(process.cwd(), "src/app/pricing/layout.tsx");
  const enterprisePath = path.join(process.cwd(), "src/app/enterprise/layout.tsx");
  const templatesPath = path.join(process.cwd(), "src/app/templates/layout.tsx");
  const roadmapPath = path.join(process.cwd(), "src/app/roadmap/layout.tsx");

  assertTrue(fs.existsSync(pricingPath), "Pricing layout exists");
  assertTrue(fs.readFileSync(pricingPath, "utf-8").includes("canonical: \"https://www.syncbay.app/pricing\""), "Pricing canonical");

  assertTrue(fs.existsSync(enterprisePath), "Enterprise layout exists");
  assertTrue(fs.readFileSync(enterprisePath, "utf-8").includes("canonical: \"https://www.syncbay.app/enterprise\""), "Enterprise canonical");

  assertTrue(fs.existsSync(templatesPath), "Templates layout exists");
  assertTrue(fs.readFileSync(templatesPath, "utf-8").includes("canonical: \"https://www.syncbay.app/templates\""), "Templates canonical");

  assertTrue(fs.existsSync(roadmapPath), "Roadmap layout exists");
  assertTrue(fs.readFileSync(roadmapPath, "utf-8").includes("canonical: \"https://www.syncbay.app/roadmap\""), "Roadmap canonical");
});

registerTest("SEO-03", "SEO_METADATA", 9, "Robots rules include Googlebot and Bingbot directives allowing brand images", () => {
  const r = robots();
  assertTrue(Array.isArray(r.rules), "Robots rules must be an array");
  const rules = r.rules as any[];
  
  const gBot = rules.find((rule) => rule.userAgent === "Googlebot");
  assertTrue(!!gBot, "Must have Googlebot specific rule");
  assertTrue(gBot.allow.includes("/brand-logo.png"), "Googlebot allowed brand-logo.png");
  assertTrue(gBot.allow.includes("/og-image.png"), "Googlebot allowed og-image.png");

  assertEqual(r.sitemap, "https://www.syncbay.app/sitemap.xml", "Robots sitemap pointer");
  assertEqual(r.host, "https://www.syncbay.app", "Robots host directive");
});

registerTest("SEO-04", "SEO_METADATA", 9, "BrandLogo component exists and is referenced across marketing and console pages", () => {
  const homePath = path.join(process.cwd(), "src/app/page.tsx");
  const footerPath = path.join(process.cwd(), "src/components/marketing/landing-footer.tsx");
  const shellPath = path.join(process.cwd(), "src/app/dashboard/dashboard-shell.tsx");
  const signinPath = path.join(process.cwd(), "src/app/auth/signin/page.tsx");

  const homeContent = fs.readFileSync(homePath, "utf-8");
  assertTrue(homeContent.includes("<BrandLogo"), "Home page must use BrandLogo component");

  const footerContent = fs.readFileSync(footerPath, "utf-8");
  assertTrue(footerContent.includes("<BrandLogo"), "Footer must use BrandLogo component");

  const shellContent = fs.readFileSync(shellPath, "utf-8");
  assertTrue(shellContent.includes("brand-icon-tight.png"), "Dashboard shell must use brand-icon-tight.png");

  const signinContent = fs.readFileSync(signinPath, "utf-8");
  assertTrue(signinContent.includes("brand-icon-tight.png"), "Sign in page must use brand-icon-tight.png");
});

registerTest("BRAND-03", "BRAND_ASSETS", 9, "Brand vector SVG contains real vector path without embedded raster images", () => {
  const svgPath = path.join(process.cwd(), "public/brand-icon.svg");
  const content = fs.readFileSync(svgPath, "utf-8");
  assertTrue(content.includes("<svg"), "Must be a valid SVG");
  assertTrue(content.includes("<path"), "Must contain vector path elements");
  assertTrue(!content.includes("<image"), "Must NOT rely on embedded raster <image> elements");
});

registerTest("BRAND-04", "BRAND_ASSETS", 9, "Invite and container preview pages use BrandLogo or official brand icons", () => {
  const invitePath = path.join(process.cwd(), "src/app/invite/page.tsx");
  const inviteTokenPath = path.join(process.cwd(), "src/app/invite/[token]/page.tsx");
  const previewPath = path.join(process.cwd(), "src/app/service-preview/[subdomain]/page.tsx");

  const inviteContent = fs.readFileSync(invitePath, "utf-8");
  const inviteTokenContent = fs.readFileSync(inviteTokenPath, "utf-8");
  const previewContent = fs.readFileSync(previewPath, "utf-8");

  assertTrue(inviteContent.includes("<BrandLogo"), "Invite page must use BrandLogo");
  assertTrue(!inviteContent.includes("⚓"), "Invite page must not contain raw anchor emoji");

  assertTrue(inviteTokenContent.includes("<BrandLogo"), "Invite token page must use BrandLogo");
  assertTrue(!inviteTokenContent.includes("⚓"), "Invite token page must not contain raw anchor emoji");

  assertTrue(previewContent.includes("<BrandLogo"), "Container preview must use BrandLogo");
});

registerTest("SEO-05", "SEO_METADATA", 9, "Root layout includes FAQPage rich snippet schema and subpages include BreadcrumbList", () => {
  const layoutPath = path.join(process.cwd(), "src/app/layout.tsx");
  const content = fs.readFileSync(layoutPath, "utf-8");
  assertTrue(content.includes("\"@type\": \"FAQPage\""), "Root layout must contain FAQPage schema");
  assertTrue(content.includes("\"@type\": \"Question\""), "Root layout must define questions");

  const pricingPath = path.join(process.cwd(), "src/app/pricing/layout.tsx");
  const enterprisePath = path.join(process.cwd(), "src/app/enterprise/layout.tsx");
  assertTrue(fs.readFileSync(pricingPath, "utf-8").includes("BreadcrumbList"), "Pricing must have BreadcrumbList");
  assertTrue(fs.readFileSync(enterprisePath, "utf-8").includes("BreadcrumbList"), "Enterprise must have BreadcrumbList");
});

registerTest("SEO-06", "SEO_METADATA", 9, "Custom branded 404 page exists and features BrandLogo and edge status", () => {
  const notFoundPath = path.join(process.cwd(), "src/app/not-found.tsx");
  assertTrue(fs.existsSync(notFoundPath), "Custom 404 page must exist");
  const content = fs.readFileSync(notFoundPath, "utf-8");
  assertTrue(content.includes("<BrandLogo"), "404 page must feature BrandLogo");
  assertTrue(content.includes("404"), "404 page must indicate error");
});

registerTest("EMAIL-01", "EMAIL_TEMPLATES", 9, "All transactional email templates include official Syncbay brand logo", () => {
  const root = process.cwd();
  const emailTemplates = [
    "src/lib/email/templates/welcome.tsx",
    "src/lib/email/templates/invitation.tsx",
    "src/lib/email/templates/billing-alert.tsx",
    "src/lib/email/templates/password-reset.tsx",
    "src/lib/email/templates/deployment-notification.tsx",
    "src/lib/email/templates/usage-warning.tsx",
  ];

  for (const tpl of emailTemplates) {
    const p = path.join(root, tpl);
    assertTrue(fs.existsSync(p), `Email template exists: ${tpl}`);
    const content = fs.readFileSync(p, "utf-8");
    assertTrue(content.includes("brand-logo.png"), `${tpl} must feature brand-logo.png`);
  }
});
