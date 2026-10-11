/**
 * Syncbay PaaS — Real-Time Telemetry & Log Event Bus (F12, F13)
 * In-memory ring buffer event bus streaming build steps and container stdout/stderr
 * with live telemetry metrics generator matching PROJECT.md interface contract.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface LogEntry {
  id: string;
  deploymentId: string;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface MetricSnapshot {
  deploymentId: string;
  timestamp: string;
  cpuPercent: number;
  memoryMiB: number;
  networkEgressKb: number;
  diskUsedMiB: number;
}

export class LogEventBus {
  private ringBuffers = new Map<string, LogEntry[]>();
  private errors = new Map<string, string>();
  private subscribers = new Map<string, Set<(log: LogEntry) => void>>();
  private maxBufferSize: number;
  private logDir: string;

  constructor(maxBufferSize = 1000) {
    this.maxBufferSize = maxBufferSize;
    this.logDir = path.join(process.cwd(), ".runner_logs");
  }

  private ensureLogDir() {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch {}
  }

  private persistToDisk(deploymentId: string) {
    try {
      this.ensureLogDir();
      const filePath = path.join(this.logDir, `${deploymentId}.json`);
      const payload = {
        deploymentId,
        error: this.errors.get(deploymentId) || null,
        logs: this.ringBuffers.get(deploymentId) || [],
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
    } catch {}
  }

  private loadFromDisk(deploymentId: string) {
    try {
      const filePath = path.join(this.logDir, `${deploymentId}.json`);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.logs && Array.isArray(parsed.logs)) {
          this.ringBuffers.set(deploymentId, parsed.logs);
        }
        if (parsed.error) {
          this.errors.set(deploymentId, parsed.error);
        }
      }
    } catch {}
  }

  publish(
    deploymentId: string,
    logLine: { timestamp?: string; stream: "stdout" | "stderr" | "system"; message: string }
  ): LogEntry {
    const entry: LogEntry = {
      id: "log_" + Math.random().toString(36).slice(2, 10),
      deploymentId,
      timestamp: logLine.timestamp || new Date().toISOString(),
      stream: logLine.stream,
      message: logLine.message,
    };

    let buffer = this.ringBuffers.get(deploymentId);
    if (!buffer) {
      buffer = [];
      this.ringBuffers.set(deploymentId, buffer);
    }

    buffer.push(entry);
    if (buffer.length > this.maxBufferSize) {
      buffer.shift(); // FIFO eviction
    }

    this.persistToDisk(deploymentId);

    const listeners = this.subscribers.get(deploymentId);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(entry);
        } catch (e) {
          console.error("Error in log listener:", e);
        }
      });
    }

    return entry;
  }

  recordError(deploymentId: string, error: string): void {
    this.errors.set(deploymentId, error);
    this.persistToDisk(deploymentId);
  }

  getError(deploymentId: string): string | null {
    if (!this.errors.has(deploymentId)) {
      this.loadFromDisk(deploymentId);
    }
    return this.errors.get(deploymentId) || null;
  }

  subscribe(deploymentId: string, listener: (log: LogEntry) => void): () => void {
    let listeners = this.subscribers.get(deploymentId);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(deploymentId, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) {
        this.subscribers.delete(deploymentId);
      }
    };
  }

  getHistory(deploymentId: string): LogEntry[] {
    if (!this.ringBuffers.has(deploymentId) || this.ringBuffers.get(deploymentId)?.length === 0) {
      this.loadFromDisk(deploymentId);
    }
    return [...(this.ringBuffers.get(deploymentId) || [])];
  }

  clear(deploymentId?: string): void {
    if (deploymentId) {
      this.ringBuffers.delete(deploymentId);
      this.errors.delete(deploymentId);
      this.subscribers.delete(deploymentId);
    } else {
      this.ringBuffers.clear();
      this.errors.clear();
      this.subscribers.clear();
    }
  }
}

export class MetricsStreamGenerator {
  private baseCpu = 5.0;
  private baseMem = 128.0;

  generateSnapshot(deploymentId: string): MetricSnapshot {
    // Generate realistic, smoothly fluctuating PaaS container metrics
    this.baseCpu = Math.max(1.0, Math.min(85.0, this.baseCpu + (Math.random() * 4 - 2)));
    this.baseMem = Math.max(64.0, Math.min(512.0, this.baseMem + (Math.random() * 8 - 4)));

    return {
      deploymentId,
      timestamp: new Date().toISOString(),
      cpuPercent: parseFloat(this.baseCpu.toFixed(1)),
      memoryMiB: parseFloat(this.baseMem.toFixed(1)),
      networkEgressKb: parseFloat((Math.random() * 150 + 20).toFixed(1)),
      diskUsedMiB: 42.5,
    };
  }
}

// Global singletons for production use (persists across Next.js webpack/worker chunks)
const globalForTelemetry = globalThis as unknown as {
  logEventBus?: LogEventBus;
  metricsGenerator?: MetricsStreamGenerator;
};

export const logEventBus = globalForTelemetry.logEventBus || new LogEventBus(1000);
export const metricsGenerator = globalForTelemetry.metricsGenerator || new MetricsStreamGenerator();

globalForTelemetry.logEventBus = logEventBus;
globalForTelemetry.metricsGenerator = metricsGenerator;
