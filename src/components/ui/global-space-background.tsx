"use client";

import React, { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { DeepSpaceScene } from "@/components/3d/deep-space-scene";

export function GlobalSpaceBackground() {
  const pathname = usePathname();
  const [motionMode, setMotionMode] = useState<"auto" | "subtle" | "hero" | "paused">("auto");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const updateMode = (val: string | null) => {
      if (val && ["auto", "subtle", "hero", "paused"].includes(val)) {
        setMotionMode(val as any);
      }
    };

    updateMode(localStorage.getItem("syncbay_cosmic_motion"));

    const handleCustomChange = (e: any) => {
      if (e?.detail) updateMode(e.detail);
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === "syncbay_cosmic_motion") {
        updateMode(e.newValue);
      }
    };

    window.addEventListener("syncbay-cosmic-motion-change", handleCustomChange as any);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("syncbay-cosmic-motion-change", handleCustomChange as any);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  if (!mounted) return null;

  // Determine effective mode
  let effectiveMode: "hero" | "subtle" | "paused" = "subtle";
  if (motionMode === "auto") {
    effectiveMode = pathname === "/" ? "hero" : "subtle";
  } else if (motionMode === "paused") {
    effectiveMode = "paused";
  } else {
    effectiveMode = motionMode;
  }

  return (
    <>
      {effectiveMode !== "paused" && (
        <DeepSpaceScene
          mode={effectiveMode === "hero" ? "hero" : "subtle"}
          interactive={true}
        />
      )}

      {/* Subtle Cosmic Ambience Gradients across all pages */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            effectiveMode === "hero"
              ? "radial-gradient(ellipse 80% 60% at 50% -20%, rgba(6,182,212,0.18) 0%, rgba(124,58,237,0.1) 40%, transparent 80%)"
              : "radial-gradient(ellipse 90% 70% at 50% -30%, rgba(6,182,212,0.08) 0%, rgba(124,58,237,0.05) 50%, transparent 90%)",
        }}
        aria-hidden="true"
      />
    </>
  );
}
