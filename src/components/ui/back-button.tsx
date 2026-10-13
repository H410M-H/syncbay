"use client";

import React from "react";
import { useRouter } from "next/navigation";

interface BackButtonProps {
  fallbackUrl?: string;
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function BackButton({
  fallbackUrl = "/dashboard",
  label = "Back",
  className = "",
  style = {},
}: BackButtonProps) {
  const router = useRouter();

  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push(fallbackUrl);
    }
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      className={`btn btn-ghost btn-sm ${className}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        color: "var(--text-secondary)",
        padding: "6px 12px",
        marginBottom: "10px",
        borderRadius: "8px",
        background: "rgba(255, 255, 255, 0.04)",
        border: "1px solid var(--border-subtle)",
        fontSize: "0.8125rem",
        fontWeight: 500,
        cursor: "pointer",
        transition: "all 0.15s ease",
        ...style,
      }}
      aria-label={label ? `Go back (${label})` : "Go back to previous page"}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
      >
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
