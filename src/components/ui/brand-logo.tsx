import React from "react";
import Image from "next/image";
import Link from "next/link";

interface BrandLogoProps {
  size?: "xs" | "sm" | "md" | "lg" | "xl" | number;
  showText?: boolean;
  suffix?: string;
  href?: string | null;
  className?: string;
  priority?: boolean;
}

const SIZE_MAP = {
  xs: { box: 24, iconW: 20, iconH: 12, text: "text-sm", suffixText: "text-xs" },
  sm: { box: 32, iconW: 26, iconH: 15, text: "text-base", suffixText: "text-xs" },
  md: { box: 40, iconW: 32, iconH: 18, text: "text-xl", suffixText: "text-sm" },
  lg: { box: 48, iconW: 40, iconH: 23, text: "text-2xl", suffixText: "text-base" },
  xl: { box: 64, iconW: 52, iconH: 30, text: "text-3xl", suffixText: "text-lg" },
};

export function BrandLogo({
  size = "md",
  showText = true,
  suffix = ".APP",
  href = "/",
  className = "",
  priority = false,
}: BrandLogoProps) {
  const dimensions =
    typeof size === "number"
      ? { box: size, iconW: Math.round(size * 0.8), iconH: Math.round(size * 0.45), text: "text-xl", suffixText: "text-sm" }
      : SIZE_MAP[size] || SIZE_MAP.md;

  const content = (
    <div className={`inline-flex items-center space-x-3 group select-none ${className}`}>
      {/* Brand Icon Mark Container */}
      <div
        className="rounded-xl flex items-center justify-center transition-all duration-300 group-hover:scale-105 relative flex-shrink-0"
        style={{
          width: `${dimensions.box}px`,
          height: `${dimensions.box}px`,
          background: "linear-gradient(135deg, rgba(6,182,212,0.18), rgba(124,58,237,0.22))",
          border: "1px solid rgba(6,182,212,0.35)",
          boxShadow: "0 0 20px rgba(6,182,212,0.25), inset 0 1px 0 rgba(255,255,255,0.15)",
        }}
      >
        <Image
          src="/brand-icon-tight.png"
          alt="Syncbay Logo"
          width={dimensions.iconW}
          height={dimensions.iconH}
          priority={priority}
          className="object-contain filter drop-shadow-[0_0_8px_rgba(6,182,212,0.5)] transition-transform duration-300 group-hover:scale-110"
        />
      </div>

      {/* Typography */}
      {showText && (
        <span className={`font-extrabold tracking-tight font-mono ${dimensions.text}`}>
          <span className="text-white">SYNCBAY</span>
          {suffix && <span style={{ color: "#06B6D4" }}>{suffix}</span>}
        </span>
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="inline-flex items-center no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded-lg">
        {content}
      </Link>
    );
  }

  return content;
}
