"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";

interface WebShellProps {
  serviceId: string;
  serviceName: string;
}

type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "meta"; cwd: string; mode: "runner" | "fallback" }
  | { type: "exit"; code: number | null };

type ConnectionStatus = "starting" | "connected" | "reconnecting" | "closed" | "error";

const MAX_OUTPUT = 200_000;

/**
 * Applies a chunk of terminal output to the transcript: honours clear-screen,
 * drops carriage returns and non-colour control sequences (cursor moves, OSC titles),
 * and keeps SGR colour codes for renderAnsi.
 */
function applyTerminalData(prev: string, data: string): string {
  let next = prev;
  let chunk = data;
  const clearIdx = Math.max(chunk.lastIndexOf("\x1b[2J"), chunk.lastIndexOf("\x1b[3J"), chunk.lastIndexOf("\x1bc"));
  if (clearIdx !== -1) {
    next = "";
    chunk = chunk.slice(clearIdx).replace(/^\x1b(\[[23]J|c)/, "");
  }
  chunk = chunk
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
  next += chunk;
  while (next.includes("\b")) {
    next = next.replace(/[^\n]?\x08/, "");
  }
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
}

/**
 * Converts ANSI color escape sequences to styled React elements
 */
function renderAnsi(text: string): React.ReactNode[] {
  // Simple ANSI color code tokenizer
  const parts = text.split(/(\x1b\[[0-9;]*m)/g);
  let currentColor = "#e2e8f0";
  let isBold = false;

  return parts.map((part, i) => {
    if (part.startsWith("\x1b[")) {
      if (part === "\x1b[0m") {
        currentColor = "#e2e8f0";
        isBold = false;
      } else if (part.includes("38;5;51m")) {
        currentColor = "#00ffff"; // Cyan
      } else if (part.includes("38;5;46m")) {
        currentColor = "#00ff66"; // Neon Green
      } else if (part.includes("38;5;201m")) {
        currentColor = "#ff007f"; // Magenta
      } else if (part.includes("38;5;220m")) {
        currentColor = "#ffd700"; // Gold
      } else if (part.includes("38;5;208m")) {
        currentColor = "#ff8800"; // Orange
      } else if (part.includes("31m")) {
        currentColor = "#ef4444"; // Red
      } else if (part.includes("32m")) {
        currentColor = "#22c55e"; // Green
      } else if (part.includes("36m")) {
        currentColor = "#06b6d4"; // Cyan
      } else if (part.includes("1m")) {
        isBold = true;
      }
      return null;
    }
    return (
      <span key={i} style={{ color: currentColor, fontWeight: isBold ? "bold" : "normal" }}>
        {part}
      </span>
    );
  });
}

export function WebShell({ serviceId, serviceName }: WebShellProps) {
  const [cwd, setCwd] = useState("/app");
  const [mode, setMode] = useState<"runner" | "fallback" | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("starting");
  const [inputVal, setInputVal] = useState("");
  const [output, setOutput] = useState(
    `\x1b[38;5;51m== SYNCBAY WEB SHELL ==\x1b[0m\nConnecting to \x1b[38;5;46m${serviceName}\x1b[0m...\n`
  );
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<string | null>(null);

  const terminalUrl = `/api/services/${encodeURIComponent(serviceId)}/terminal`;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output]);

  // Open a session, then attach to its SSE stream. EventSource reconnects on its own;
  // every (re)connect replays the session buffer, so the transcript is reset on open.
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    (async () => {
      try {
        const res = await fetch(terminalUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (cancelled) {
          fetch(`${terminalUrl}?sessionId=${encodeURIComponent(data.sessionId)}`, { method: "DELETE" }).catch(() => {});
          return;
        }
        sessionRef.current = data.sessionId;
        setMode(data.mode);

        source = new EventSource(`${terminalUrl}/stream?sessionId=${encodeURIComponent(data.sessionId)}`);
        source.onopen = () => {
          setStatus("connected");
          setOutput("");
        };
        source.onmessage = (e) => {
          let event: TerminalEvent;
          try {
            event = JSON.parse(e.data);
          } catch {
            return;
          }
          if (event.type === "output") {
            setOutput((prev) => applyTerminalData(prev, event.data));
          } else if (event.type === "meta") {
            setCwd(event.cwd);
            setMode(event.mode);
          } else if (event.type === "exit") {
            setStatus("closed");
            setOutput((prev) => prev + `\n\x1b[38;5;208m[session ended${event.code != null ? ` (exit ${event.code})` : ""}]\x1b[0m\n`);
            source?.close();
          }
        };
        source.onerror = () => {
          setStatus((prev) => (prev === "closed" ? prev : "reconnecting"));
        };
      } catch (err: any) {
        if (cancelled) return;
        setStatus("error");
        setOutput((prev) => prev + `\x1b[31mError: ${err.message}\x1b[0m\n`);
      }
    })();

    return () => {
      cancelled = true;
      source?.close();
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      if (sessionId) {
        fetch(`${terminalUrl}?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
      }
    };
  }, [terminalUrl]);

  const sendInput = useCallback(
    async (input: string) => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      setIsSending(true);
      try {
        const res = await fetch(terminalUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, input }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      } catch (err: any) {
        setOutput((prev) => prev + `\x1b[31mError: ${err.message}\x1b[0m\n`);
      } finally {
        setIsSending(false);
        inputRef.current?.focus();
      }
    },
    [terminalUrl]
  );

  const handleCommand = async (cmdToRun?: string) => {
    const command = (cmdToRun ?? inputVal).trim();
    if (!command) return;

    setHistory((prev) => [...prev, command]);
    setHistoryIdx(-1);
    setInputVal("");

    if (command === "clear") {
      setOutput("");
    }
    await sendInput(`${command}\n`);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCommand();
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      setInputVal("");
      sendInput("\x03");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(nextIdx);
      setInputVal(history[nextIdx] || "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx === -1) return;
      const nextIdx = historyIdx + 1;
      if (nextIdx >= history.length) {
        setHistoryIdx(-1);
        setInputVal("");
      } else {
        setHistoryIdx(nextIdx);
        setInputVal(history[nextIdx] || "");
      }
    }
  };

  const quickActions = [
    { label: "Check Processes", cmd: "ps aux" },
    { label: "System Load", cmd: "top -b -n 1" },
    { label: "Disk Space", cmd: "df -h" },
    { label: "Memory", cmd: "free -m" },
    { label: "Env Vars", cmd: "env" },
    { label: "Health Probe", cmd: "curl -s http://localhost:3000/health" },
    { label: "Kernel Info", cmd: "uname -a" },
    { label: "Clear Buffer", cmd: "clear" },
  ];

  const statusDot =
    status === "connected"
      ? "bg-emerald-400 animate-pulse"
      : status === "closed" || status === "error"
      ? "bg-red-500"
      : "bg-yellow-400 animate-pulse";
  const isReady = status === "connected" && !isSending;

  return (
    <div
      className={`flex flex-col border border-zinc-800 rounded-lg overflow-hidden bg-black text-white font-mono text-xs shadow-2xl transition-all ${
        isFullscreen ? "fixed inset-4 z-50 rounded-xl" : "h-[540px] w-full"
      }`}
    >
      {/* Terminal Titlebar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900 border-b border-zinc-800 select-none">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
          <span className="ml-2 text-zinc-400 font-semibold text-xs flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${statusDot}`} />
            syncbay-shell: {serviceName}
            {mode === "fallback" ? ` (${cwd})` : ""}
          </span>
        </div>

        <div className="flex items-center space-x-3 text-zinc-400">
          <span className="text-[11px] text-zinc-500 hidden sm:inline">
            {mode === "runner" ? "runner pty" : mode === "fallback" ? "simulated" : status} · xterm-256color
          </span>
          <button
            type="button"
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="hover:text-white px-2 py-1 bg-zinc-800 rounded text-[10px] uppercase font-bold"
          >
            {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          </button>
        </div>
      </div>

      {/* Quick Diagnostic Actions Bar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-950/80 border-b border-zinc-800/80 overflow-x-auto scrollbar-none">
        <span className="text-[10px] text-zinc-500 uppercase font-semibold mr-1">Quick:</span>
        {quickActions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => handleCommand(action.cmd)}
            disabled={!isReady}
            className="px-2 py-0.5 rounded bg-zinc-900 hover:bg-cyan-950/60 hover:text-cyan-400 hover:border-cyan-800/50 border border-zinc-800 text-[10px] text-zinc-300 transition-colors whitespace-nowrap"
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* Terminal Output Area (prompts are part of the stream) */}
      <div
        className="flex-1 p-4 overflow-y-auto select-text scrollbar-thin scrollbar-thumb-zinc-800"
        onClick={() => inputRef.current?.focus()}
      >
        <div className="whitespace-pre-wrap break-all leading-relaxed">
          {renderAnsi(output)}
          <input
            ref={inputRef}
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={status === "closed" || status === "error"}
            autoFocus
            aria-label="Terminal input"
            style={{ width: `${Math.max(inputVal.length + 2, 24)}ch`, maxWidth: "100%" }}
            className="inline bg-transparent outline-none border-none text-white font-mono text-xs p-0 focus:ring-0"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
