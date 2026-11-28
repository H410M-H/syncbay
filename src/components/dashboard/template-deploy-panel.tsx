"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";

const SERVICE_LABEL: Record<string, string> = { postgres: "PostgreSQL 16", redis: "Redis 7", valkey: "Valkey 8" };

export interface TemplateDeployRequest {
  source: string;
  projectName: string;
  env: Record<string, string>;
}

/**
 * The template half of the new-project wizard: shows what the repository's syncbay.json will
 * provision (services, variables, port, health path) and collects variable values. Generated
 * secrets are created on the server; secret inputs are masked.
 */
export function TemplateDeployPanel({
  template,
  disabled,
  busy,
  onDeploy,
  onCancel,
}: {
  template: string;
  disabled?: boolean;
  busy?: boolean;
  onDeploy: (request: TemplateDeployRequest) => void;
  onCancel: () => void;
}) {
  const preview = trpc.template.preview.useQuery({ source: template }, { retry: false, staleTime: 60_000 });
  const data = preview.data;
  const manifest = data?.manifest ?? null;

  const [values, setValues] = useState<Record<string, string>>({});
  const [projectName, setProjectName] = useState("");
  const [touched, setTouched] = useState(false);

  const defaultName = data?.catalog?.slug || data?.source.repo.replace(/^syncbay-template-/, "") || "";
  const valueOf = (key: string, fallback: string | null) => values[key] ?? fallback ?? "";
  const missing = (manifest?.env || []).filter((e) => e.required && !e.generated && !valueOf(e.key, e.default).trim()).map((e) => e.key);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!data || missing.length) return;
    const env: Record<string, string> = {};
    for (const entry of manifest?.env || []) {
      if (entry.generated && !values[entry.key]) continue; // generated on the server
      const v = valueOf(entry.key, entry.default);
      if (v !== "") env[entry.key] = v;
    }
    onDeploy({ source: data.source.fullName, projectName: (projectName.trim() || defaultName).slice(0, 64), env });
  };

  return (
    <div className="card" style={{ marginBottom: "24px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "16px" }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div style={{ fontSize: "24px" }} aria-hidden>
            {data?.catalog?.icon || "📦"}
          </div>
          <div>
            <h3 style={{ margin: 0 }}>{data?.catalog?.name || manifest?.name || template}</h3>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "2px" }}>
              <a href={`https://github.com/${data?.source.fullName || template}`} target="_blank" rel="noreferrer">
                github.com/{data?.source.fullName || template}
              </a>
              {data ? ` · branch: ${data.branch}` : ""}
            </div>
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Choose another source
        </button>
      </div>

      {preview.isLoading ? (
        <div style={{ textAlign: "center", padding: "24px" }}>
          <div className="loading-bar" style={{ width: "100px", margin: "0 auto 12px" }}></div>
          <p style={{ color: "var(--text-muted)" }}>Reading syncbay.json…</p>
        </div>
      ) : preview.error ? (
        <div role="alert" style={{ color: "#fca5a5", fontSize: "0.875rem" }}>
          {preview.error.message}
        </div>
      ) : data ? (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {(data.catalog?.description || manifest?.description) && (
            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", margin: 0 }}>{data.catalog?.description || manifest?.description}</p>
          )}

          {data.manifestStatus === "absent" && (
            <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", margin: 0 }}>
              This repository has no <code>syncbay.json</code>. It is deployed as a single service; add databases and variables afterwards.
            </p>
          )}
          {data.manifestError && (
            <div role="alert" style={{ fontSize: "0.8125rem", color: "#fca5a5" }}>
              {data.manifestError}
            </div>
          )}

          {manifest && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", fontSize: "0.8125rem" }}>
              <div style={{ padding: "12px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", background: "var(--bg-overlay)" }}>
                <div style={{ fontWeight: 600, marginBottom: "6px" }}>Services to provision</div>
                {manifest.services.length === 0 ? (
                  <div style={{ color: "var(--text-muted)" }}>None</div>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: "18px" }}>
                    {manifest.services.map((s) => (
                      <li key={`${s.type}-${s.env}`}>
                        {SERVICE_LABEL[s.type] || s.type}
                        {s.extensions.includes("vector") ? " + pgvector" : ""} → <code>{s.env}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div style={{ padding: "12px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", background: "var(--bg-overlay)" }}>
                <div style={{ fontWeight: 600, marginBottom: "6px" }}>App</div>
                <div>
                  Port: <code>{manifest.port ?? "auto-detected"}</code>
                </div>
                <div>
                  Health check: <code>{manifest.healthcheckPath ?? "/health"}</code>
                </div>
              </div>
            </div>
          )}

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="tpl-project-name">Project name</label>
            <input
              id="tpl-project-name"
              className="input"
              placeholder={defaultName}
              value={projectName}
              maxLength={64}
              onChange={(e) => setProjectName(e.target.value)}
            />
          </div>

          {manifest && manifest.env.length > 0 && (
            <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px" }}>
              <legend style={{ fontWeight: 600, marginBottom: "8px" }}>Environment variables</legend>
              {manifest.env.map((entry) => {
                const id = `tpl-env-${entry.key}`;
                const isMissing = touched && missing.includes(entry.key);
                return (
                  <div key={entry.key} className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor={id} style={{ fontFamily: "monospace" }}>
                      {entry.key}
                      {entry.required && !entry.generated ? " *" : ""}
                    </label>
                    <input
                      id={id}
                      className="input"
                      type={entry.secret ? "password" : "text"}
                      autoComplete="off"
                      spellCheck={false}
                      required={entry.required && !entry.generated}
                      aria-invalid={isMissing || undefined}
                      aria-describedby={entry.description ? `${id}-help` : undefined}
                      placeholder={entry.generated ? "Generated securely on deploy" : entry.default ?? ""}
                      value={valueOf(entry.key, entry.generated ? null : entry.default)}
                      onChange={(e) => setValues((v) => ({ ...v, [entry.key]: e.target.value }))}
                      style={{ fontFamily: "monospace", fontSize: "0.875rem", borderColor: isMissing ? "rgba(239,68,68,0.6)" : undefined }}
                    />
                    {entry.description && (
                      <div id={`${id}-help`} style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "4px" }}>
                        {entry.description}
                        {entry.generated ? " · a random 32-byte value is generated if left empty" : ""}
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}

          {touched && missing.length > 0 && (
            <div role="alert" style={{ fontSize: "0.8125rem", color: "#fca5a5" }}>
              Fill in the required variable{missing.length === 1 ? "" : "s"}: {missing.join(", ")}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={disabled || busy || data.manifestStatus === "invalid" || data.manifestStatus === "unreachable"}
            style={{ alignSelf: "flex-start" }}
          >
            {busy ? "Provisioning & deploying…" : "🚀 Deploy template"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
