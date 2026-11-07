"use client";

/**
 * Shown on the project page when the new-project wizard created the project but a later step
 * (service creation or the first deploy) failed: the wizard opens the project with
 * `?setupError=<message>` instead of offering to create a duplicate.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function ProjectSetupNotice() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const message = params.get("setupError");
  if (!message) return null;

  const dismiss = () => {
    const next = new URLSearchParams(params.toString());
    next.delete("setupError");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div
      role="alert"
      className="card"
      style={{
        marginBottom: "20px",
        padding: "14px 18px",
        borderColor: "rgba(239,68,68,0.45)",
        display: "flex",
        alignItems: "flex-start",
        gap: "12px",
      }}
    >
      <div style={{ flex: 1, fontSize: "0.875rem", color: "#fca5a5" }}>
        <strong style={{ color: "#f87171" }}>The project was created, but setup did not finish.</strong>{" "}
        {message} Fix the cause, then deploy from this page; the wizard will not create another copy.
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={dismiss} aria-label="Dismiss setup error">
        ×
      </button>
    </div>
  );
}
