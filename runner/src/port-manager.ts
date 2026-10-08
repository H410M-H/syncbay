/**
 * Syncbay Runner Agent — Dynamic Port Manager
 *
 * Manages allocation, collision avoidance, and release of host ports
 * for isolated application containers within the pool (e.g. 10000 - 60000).
 */

import net from "node:net";

export interface PortManagerOptions {
  rangeStart?: number;
  rangeEnd?: number;
  reservedPorts?: number[];
}

export interface PortAllocation {
  port: number;
  serviceId?: string;
  jobId?: string;
  allocatedAt: number;
}

export class PortManager {
  private readonly rangeStart: number;
  private readonly rangeEnd: number;
  private readonly reservedPorts: Set<number>;
  private readonly allocatedPorts: Map<number, PortAllocation>;
  private readonly serviceToPort: Map<string, number>;
  private readonly jobToPort: Map<string, number>;
  private allocationMutex: Promise<any> = Promise.resolve();

  constructor(options: PortManagerOptions = {}) {
    this.rangeStart = options.rangeStart ?? 10000;
    this.rangeEnd = options.rangeEnd ?? 60000;
    this.reservedPorts = new Set(options.reservedPorts || []);
    this.allocatedPorts = new Map();
    this.serviceToPort = new Map();
    this.jobToPort = new Map();
    this.allocationMutex = Promise.resolve();

    if (this.rangeStart >= this.rangeEnd) {
      throw new Error(`Invalid port range: ${this.rangeStart} >= ${this.rangeEnd}`);
    }
  }

  /**
   * Tests whether a port is currently available on the host operating system.
   */
  public async isSocketAvailable(port: number, host: string = "127.0.0.1"): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once("error", () => {
        resolve(false);
      });

      server.once("listening", () => {
        server.close(() => {
          resolve(true);
        });
      });

      try {
        server.listen(port, host);
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Checks whether a port is available both internally in the allocator
   * and externally on the OS network interface.
   */
  public async isPortAvailable(port: number): Promise<boolean> {
    if (port < this.rangeStart || port > this.rangeEnd) {
      return false;
    }
    if (this.reservedPorts.has(port)) {
      return false;
    }
    if (this.allocatedPorts.has(port)) {
      return false;
    }

    return await this.isSocketAvailable(port);
  }

  /**
   * Checks whether a port is currently registered in the manager's active allocations.
   */
  public isPortAllocated(port: number): boolean {
    return this.allocatedPorts.has(port);
  }

  /**
   * Dynamically allocates an available port with collision avoidance.
   * Guarded by an allocation mutex to serialize concurrent invocations,
   * ensuring concurrent requests for the same serviceId do not race or leak ports.
   */
  public async allocatePort(serviceId?: string, jobId?: string): Promise<number> {
    const prevLock = this.allocationMutex;
    let releaseLock: () => void;
    this.allocationMutex = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;
      return await this.doAllocatePort(serviceId, jobId);
    } finally {
      releaseLock!();
    }
  }

  private async doAllocatePort(serviceId?: string, jobId?: string): Promise<number> {
    // Re-check under the mutex if service already has an allocated port
    if (serviceId && this.serviceToPort.has(serviceId)) {
      const existing = this.serviceToPort.get(serviceId)!;
      if (this.allocatedPorts.has(existing)) {
        return existing;
      }
    }

    // Scan through range looking for an available port
    for (let port = this.rangeStart; port <= this.rangeEnd; port++) {
      if (this.reservedPorts.has(port) || this.allocatedPorts.has(port)) {
        continue;
      }

      const available = await this.isSocketAvailable(port);
      if (available) {
        const allocation: PortAllocation = {
          port,
          serviceId,
          jobId,
          allocatedAt: Date.now(),
        };

        this.allocatedPorts.set(port, allocation);
        if (serviceId) {
          this.serviceToPort.set(serviceId, port);
        }
        if (jobId) {
          this.jobToPort.set(jobId, port);
        }

        return port;
      }
    }

    throw new Error(`Port pool exhausted: no available ports in range ${this.rangeStart}-${this.rangeEnd}`);
  }

  /**
   * Synchronous reservation when async socket probing is bypassed or handled separately.
   * Validates that port is within [rangeStart, rangeEnd], not reserved, and not already allocated.
   */
  public reservePortSync(port: number, serviceId?: string, jobId?: string): number {
    if (!Number.isInteger(port) || port < this.rangeStart || port > this.rangeEnd) {
      throw new Error(`Port ${port} is outside allowed range ${this.rangeStart}-${this.rangeEnd}`);
    }

    if (this.reservedPorts.has(port)) {
      throw new Error(`Port ${port} is a system-reserved port`);
    }

    if (this.allocatedPorts.has(port)) {
      throw new Error(`Port ${port} is already allocated`);
    }

    const allocation: PortAllocation = {
      port,
      serviceId,
      jobId,
      allocatedAt: Date.now(),
    };

    this.allocatedPorts.set(port, allocation);
    if (serviceId) {
      this.serviceToPort.set(serviceId, port);
    }
    if (jobId) {
      this.jobToPort.set(jobId, port);
    }

    return port;
  }

  /**
   * Releases a previously allocated port back to the pool.
   */
  public releasePort(port: number): boolean {
    const allocation = this.allocatedPorts.get(port);
    if (!allocation) {
      return false;
    }

    this.allocatedPorts.delete(port);
    if (allocation.serviceId && this.serviceToPort.get(allocation.serviceId) === port) {
      this.serviceToPort.delete(allocation.serviceId);
    }
    if (allocation.jobId && this.jobToPort.get(allocation.jobId) === port) {
      this.jobToPort.delete(allocation.jobId);
    }

    return true;
  }

  /**
   * Releases port assigned to a specific service.
   */
  public releaseServicePort(serviceId: string): boolean {
    const port = this.serviceToPort.get(serviceId);
    if (port !== undefined) {
      return this.releasePort(port);
    }
    return false;
  }

  /**
   * Releases port assigned to a specific job.
   */
  public releaseJobPort(jobId: string): boolean {
    const port = this.jobToPort.get(jobId);
    if (port !== undefined) {
      return this.releasePort(port);
    }
    return false;
  }

  /**
   * Returns port assigned to a service, if any.
   */
  public getPortForService(serviceId: string): number | undefined {
    return this.serviceToPort.get(serviceId);
  }

  /**
   * Returns all currently allocated ports.
   */
  public getAllocatedPorts(): number[] {
    return Array.from(this.allocatedPorts.keys());
  }

  /**
   * Returns full allocation records.
   */
  public getAllocations(): PortAllocation[] {
    return Array.from(this.allocatedPorts.values());
  }

  /**
   * Clears all allocations (useful for testing and reset).
   */
  public reset(): void {
    this.allocatedPorts.clear();
    this.serviceToPort.clear();
    this.jobToPort.clear();
    this.allocationMutex = Promise.resolve();
  }
}

export const defaultPortManager = new PortManager();
