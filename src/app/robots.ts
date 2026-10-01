import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL && !process.env.NEXT_PUBLIC_APP_URL.includes("localhost")
      ? process.env.NEXT_PUBLIC_APP_URL
      : "https://www.syncbay.app";

  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/pricing",
          "/enterprise",
          "/templates",
          "/roadmap",
          "/auth/signin",
          "/api/v1/openapi.json",
          "/api/geo/locate",
          "/og-image.png",
          "/brand-logo.png",
          "/brand-icon.png",
          "/brand-icon-tight.png",
          "/brand-icon.svg",
          "/syncbay-avatar.png",
          "/site.webmanifest",
        ],
        disallow: [
          "/dashboard/",
          "/api/deployments/",
          "/api/trpc/",
          "/invite/",
        ],
      },
      {
        userAgent: "Googlebot",
        allow: [
          "/",
          "/pricing",
          "/enterprise",
          "/templates",
          "/roadmap",
          "/auth/signin",
          "/og-image.png",
          "/brand-logo.png",
          "/brand-icon.png",
          "/brand-icon-tight.png",
          "/brand-icon.svg",
          "/syncbay-avatar.png",
        ],
        disallow: ["/dashboard/", "/api/trpc/", "/invite/"],
      },
      {
        userAgent: "Bingbot",
        allow: [
          "/",
          "/pricing",
          "/enterprise",
          "/templates",
          "/roadmap",
          "/auth/signin",
          "/og-image.png",
          "/brand-logo.png",
          "/brand-icon.png",
          "/brand-icon-tight.png",
          "/brand-icon.svg",
          "/syncbay-avatar.png",
        ],
        disallow: ["/dashboard/", "/api/trpc/", "/invite/"],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
