"use client";

import React, { useState } from "react";
import { trpc } from "@/lib/trpc-client";

interface QueryStudioProps {
  databases: any[];
}

export function QueryStudio({ databases }: QueryStudioProps) {
  const [selectedDbId, setSelectedDbId] = useState<string>(databases[0]?.id || "");
  const [query, setQuery] = useState<string>("SELECT * FROM users LIMIT 10;");
  const [safeMode, setSafeMode] = useState<boolean>(true);
  const [writeMode, setWriteMode] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"results" | "schema">("results");

  const activeDb = databases.find((d) => d.id === selectedDbId) || databases[0];

  const { data: schemaData, isLoading: schemaLoading } = trpc.queryStudio.getSchema.useQuery(
    { databaseId: selectedDbId },
    { enabled: !!selectedDbId }
  );

  const executeMutation = trpc.queryStudio.execute.useMutation();

  const handleRunQuery = () => {
    if (!selectedDbId || !query.trim()) return;
    executeMutation.mutate({
      databaseId: selectedDbId,
      query: query.trim(),
      safeMode,
      mode: writeMode && schemaData?.canWrite ? "write" : "read",
    });
  };

  const handleTableClick = (tableName: string) => {
    if (activeDb?.provider === "REDIS") {
      setQuery("KEYS *");
    } else {
      setQuery(`SELECT * FROM ${tableName} LIMIT 20;`);
    }
  };

  const exportToJson = () => {
    if (!executeMutation.data?.rows) return;
    const blob = new Blob([JSON.stringify(executeMutation.data.rows, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query-result-${Date.now()}.json`;
    a.click();
  };

  if (databases.length === 0) {
    return (
      <div className="p-8 text-center border border-zinc-800 rounded-lg bg-zinc-950 text-zinc-400">
        <div className="text-3xl mb-2">🗄️</div>
        <h3 className="text-base font-semibold text-white mb-1">No Databases Attached</h3>
        <p className="text-xs text-zinc-500 mb-4">
          Provision a Managed PostgreSQL or Redis instance to unlock the interactive Query Studio.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[650px] border border-zinc-800 rounded-xl bg-zinc-950 overflow-hidden font-mono text-xs shadow-2xl">
      {/* Top Controls Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center space-x-3">
          <span className="text-cyan-400 font-bold text-sm flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            Syncbay Query Studio
          </span>
          <select
            value={selectedDbId}
            onChange={(e) => {
              setSelectedDbId(e.target.value);
              const target = databases.find((d) => d.id === e.target.value);
              if (target?.provider === "REDIS") {
                setQuery("INFO");
              } else {
                setQuery("SELECT * FROM users LIMIT 10;");
              }
            }}
            className="bg-black border border-zinc-700 text-white rounded px-2.5 py-1 text-xs focus:outline-none focus:border-cyan-500"
          >
            {databases.map((db) => (
              <option key={db.id} value={db.id}>
                {db.name} ({db.provider})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center space-x-3">
          <label className="flex items-center space-x-1.5 text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={safeMode}
              onChange={(e) => setSafeMode(e.target.checked)}
              className="rounded bg-black border-zinc-700 text-cyan-500 focus:ring-0"
            />
            <span className="text-[11px]">Safe Mode Guard</span>
          </label>
          {schemaData?.canWrite && (
            <label className="flex items-center space-x-1.5 text-zinc-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={writeMode}
                onChange={(e) => setWriteMode(e.target.checked)}
                className="rounded bg-black border-zinc-700 text-amber-500 focus:ring-0"
              />
              <span className="text-[11px]">{writeMode ? "Write mode" : "Read-only"}</span>
            </label>
          )}

          <button
            type="button"
            onClick={handleRunQuery}
            disabled={executeMutation.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded transition-colors"
          >
            {executeMutation.isPending ? "Running..." : "▶ Run Query"}
          </button>
        </div>
      </div>

      {/* Main Workspace Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Schema Tree Sidebar */}
        <div className="w-64 border-r border-zinc-800 bg-black p-3 overflow-y-auto flex flex-col">
          <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider mb-2">
            Schema Tables ({schemaData?.tables?.length || 0})
          </div>

          {schemaLoading ? (
            <div className="text-zinc-600 text-[11px]">Inspecting tables...</div>
          ) : (
            <div className="space-y-3">
              {schemaData?.tables?.map((table) => (
                <div key={table.tableName} className="group">
                  <button
                    type="button"
                    onClick={() => handleTableClick(table.tableName)}
                    className="flex items-center justify-between w-full text-left font-semibold text-zinc-300 hover:text-cyan-400 py-1 text-xs"
                  >
                    <span>📁 {table.tableName}</span>
                    <span className="text-[10px] text-zinc-500">~{table.rowCountEstimate} rows</span>
                  </button>
                  <div className="pl-4 space-y-0.5 border-l border-zinc-800 ml-1.5 my-1">
                    {table.columns.map((col) => (
                      <div key={col.name} className="flex items-center justify-between text-[11px] text-zinc-400">
                        <span className={col.isPrimaryKey ? "text-yellow-400 font-bold" : ""}>
                          {col.isPrimaryKey ? "🔑 " : ""}{col.name}
                        </span>
                        <span className="text-[10px] text-zinc-600">{col.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right Editor & Results Area */}
        <div className="flex-1 flex flex-col overflow-hidden bg-zinc-950">
          {/* Query Editor Box */}
          <div className="p-3 border-b border-zinc-800 bg-black/60 flex flex-col">
            <div className="flex items-center justify-between text-[11px] text-zinc-500 mb-1.5">
              <span>SQL / Redis Command Editor (Ctrl+Enter to Execute)</span>
              <div className="space-x-2">
                <button
                  type="button"
                  onClick={() => setQuery("EXPLAIN ANALYZE SELECT * FROM users;")}
                  className="text-[10px] text-zinc-400 hover:text-cyan-300"
                >
                  Explain Plan
                </button>
                <button
                  type="button"
                  onClick={() => setQuery("SELECT * FROM services;")}
                  className="text-[10px] text-zinc-400 hover:text-cyan-300"
                >
                  Services
                </button>
              </div>
            </div>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleRunQuery();
                }
              }}
              rows={4}
              className="w-full bg-zinc-900 border border-zinc-800 rounded p-2.5 text-white font-mono text-xs focus:outline-none focus:border-cyan-500 resize-none"
              spellCheck={false}
            />
          </div>

          {/* Results Header / Stats */}
          <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/60 border-b border-zinc-800 text-[11px]">
            <div className="flex items-center space-x-3">
              {executeMutation.data && (
                <span className="text-emerald-400 font-semibold">
                  ✔ {executeMutation.data.rowCount} row(s) returned in {executeMutation.data.durationMs}ms
                </span>
              )}
              {executeMutation.error && (
                <span className="text-red-400 font-semibold">
                  ⚠ Error: {executeMutation.error.message}
                </span>
              )}
              {!executeMutation.data && !executeMutation.error && (
                <span className="text-zinc-500">Ready to execute query</span>
              )}
            </div>

            {executeMutation.data?.rows && executeMutation.data.rows.length > 0 && (
              <button
                type="button"
                onClick={exportToJson}
                className="text-[10px] px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded"
              >
                Export JSON
              </button>
            )}
          </div>

          {/* Results Table Grid */}
          <div className="flex-1 overflow-auto p-2">
            {executeMutation.data?.rows && executeMutation.data.rows.length > 0 ? (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900/80 sticky top-0">
                    {executeMutation.data.columns.map((col) => (
                      <th key={col.name} className="px-3 py-2 font-semibold text-zinc-300 text-xs">
                        {col.name}
                        <span className="ml-1 text-[10px] text-zinc-500 font-normal">({col.type})</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {executeMutation.data.rows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-zinc-900/40">
                      {executeMutation.data?.columns.map((col) => (
                        <td key={col.name} className="px-3 py-2 text-zinc-300 text-xs truncate max-w-xs">
                          {row[col.name] !== undefined ? String(row[col.name]) : "NULL"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="h-full flex items-center justify-center text-zinc-600 text-xs">
                {executeMutation.isPending ? "Executing query..." : "Run a query above to inspect data rows."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
