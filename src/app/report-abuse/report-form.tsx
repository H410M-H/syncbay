"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { AbuseCategory } from "@/lib/admin/permissions";
import { ABUSE_CATEGORY_IDS, ABUSE_CATEGORY_LABELS, NCMEC_REPORT_URL } from "@/components/admin/abuse-categories";

type Field = "category" | "url" | "description" | "reporterEmail";
type FieldErrors = Partial<Record<Field, string>>;

/** Off-screen but still a real text input, so naive bots fill it. */
const HONEYPOT_STYLE: CSSProperties = { position: "absolute", left: "-10000px", top: "auto", width: "1px", height: "1px", overflow: "hidden" };

const errorStyle: CSSProperties = { color: "#fca5a5", fontSize: "0.8125rem" };

export function ReportAbuseForm() {
  const renderedAt = useRef(0);
  const [category, setCategory] = useState<AbuseCategory | "">("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [reporterEmail, setReporterEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reference: string | null } | null>(null);

  useEffect(() => {
    renderedAt.current = Date.now();
  }, []);

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!category) errors.category = "Choose a category.";
    if (url.trim().length < 4) errors.url = "Enter the URL or hostname of the content.";
    if (description.trim().length < 10) errors.description = "Describe the problem in at least 10 characters.";
    if (reporterEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail.trim())) errors.reporterEmail = "Enter a valid email or leave it empty.";
    return errors;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/abuse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          url: url.trim(),
          description: description.trim(),
          reporterEmail: reporterEmail.trim() || undefined,
          website,
          renderedAt: renderedAt.current || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { reference?: string | null; error?: string; issues?: Record<string, string[] | undefined> };
      if (res.ok) {
        setDone({ reference: body.reference ?? null });
        return;
      }
      if (res.status === 400 && body.issues) {
        const next: FieldErrors = {};
        for (const key of ["category", "url", "description", "reporterEmail"] as Field[]) {
          const msg = body.issues[key]?.[0];
          if (msg) next[key] = msg;
        }
        setFieldErrors(next);
        setFormError(body.error || "Please check the form.");
      } else if (res.status === 429) {
        setFormError(body.error || "Too many reports from this address. Try again later or email abuse@syncbay.app.");
      } else {
        setFormError(body.error || "Could not send the report. Email abuse@syncbay.app.");
      }
    } catch {
      setFormError("Could not reach Syncbay. Check your connection, or email abuse@syncbay.app.");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="card" role="status">
        <h2 style={{ fontSize: "1.125rem", margin: "0 0 8px" }}>Thank you, your report was received.</h2>
        {done.reference ? (
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
            Reference: <code>{done.reference}</code>. Quote it if you contact us about this report.
          </p>
        ) : (
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>Our team will review it.</p>
        )}
        {category === "CSAM" && <NcmecNote />}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ marginTop: "16px" }}
          onClick={() => {
            setDone(null);
            setCategory("");
            setUrl("");
            setDescription("");
            setReporterEmail("");
            renderedAt.current = Date.now();
          }}
        >
          Report something else
        </button>
      </div>
    );
  }

  const describedBy = (field: Field, hint?: string) => [hint, fieldErrors[field] ? `${field}-error` : null].filter(Boolean).join(" ") || undefined;

  return (
    <form className="card" onSubmit={onSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: "16px", position: "relative" }}>
      <div className="field">
        <label htmlFor="category">What kind of abuse?</label>
        <select
          id="category"
          className="input"
          value={category}
          onChange={(e) => setCategory(e.target.value as AbuseCategory | "")}
          aria-invalid={Boolean(fieldErrors.category)}
          aria-describedby={describedBy("category")}
          required
        >
          <option value="">Choose a category</option>
          {ABUSE_CATEGORY_IDS.map((id) => (
            <option key={id} value={id}>
              {ABUSE_CATEGORY_LABELS[id]}
            </option>
          ))}
        </select>
        {fieldErrors.category && (
          <span id="category-error" style={errorStyle}>
            {fieldErrors.category}
          </span>
        )}
      </div>

      {category === "CSAM" && <NcmecNote />}

      <div className="field">
        <label htmlFor="url">URL</label>
        <input
          id="url"
          className="input"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={2000}
          placeholder="https://example.syncbay.app/page"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={Boolean(fieldErrors.url)}
          aria-describedby={describedBy("url")}
          required
        />
        {fieldErrors.url && (
          <span id="url-error" style={errorStyle}>
            {fieldErrors.url}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="description">What is happening?</label>
        <textarea
          id="description"
          className="input"
          rows={5}
          maxLength={5000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-invalid={Boolean(fieldErrors.description)}
          aria-describedby={describedBy("description", "description-hint")}
          style={{ resize: "vertical" }}
          required
        />
        <span id="description-hint" className="field-hint">
          Describe what you saw and why it is abusive. Do not attach or paste illegal material.
        </span>
        {fieldErrors.description && (
          <span id="description-error" style={errorStyle}>
            {fieldErrors.description}
          </span>
        )}
      </div>

      <div className="field">
        <label htmlFor="reporterEmail">Your email (optional)</label>
        <input
          id="reporterEmail"
          className="input"
          type="email"
          autoComplete="email"
          maxLength={200}
          value={reporterEmail}
          onChange={(e) => setReporterEmail(e.target.value)}
          aria-invalid={Boolean(fieldErrors.reporterEmail)}
          aria-describedby={describedBy("reporterEmail", "email-hint")}
        />
        <span id="email-hint" className="field-hint">
          Only used if we need more details. Leave it empty to report anonymously.
        </span>
        {fieldErrors.reporterEmail && (
          <span id="reporterEmail-error" style={errorStyle}>
            {fieldErrors.reporterEmail}
          </span>
        )}
      </div>

      {/* Honeypot: hidden from people and assistive tech, left in the DOM for bots. */}
      <div style={HONEYPOT_STYLE} aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>

      {formError && (
        <div
          role="alert"
          style={{ padding: "10px 12px", borderRadius: "var(--radius-md)", border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.1)", ...errorStyle }}
        >
          {formError}
        </div>
      )}

      <div>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Sending…" : "Send report"}
        </button>
      </div>
    </form>
  );
}

function NcmecNote() {
  return (
    <div
      role="note"
      style={{
        marginTop: "4px",
        padding: "12px 14px",
        borderRadius: "var(--radius-md)",
        border: "1px solid rgba(239,68,68,0.4)",
        background: "rgba(239,68,68,0.08)",
        color: "#fca5a5",
        fontSize: "0.875rem",
        lineHeight: 1.55,
      }}
    >
      If you have found child sexual abuse material, please also report it to the National Center for Missing &amp; Exploited Children (NCMEC) CyberTipline at{" "}
      <a href={NCMEC_REPORT_URL} target="_blank" rel="noopener noreferrer" style={{ color: "#fecaca", textDecoration: "underline" }}>
        report.cybertip.org
      </a>
      . Do not download, copy or send us the material itself; the URL is enough.
    </div>
  );
}
