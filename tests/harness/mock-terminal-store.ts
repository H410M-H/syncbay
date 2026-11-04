/**
 * In-memory stand-in for `prisma.terminalSession`, for tsx tests that run with a mocked
 * `globalThis.prisma`. Implements just the calls src/lib/shell/terminal-sessions.ts makes.
 */

type Row = Record<string, any> & { id: string };

export function createMockTerminalSessionDelegate() {
  const rows = new Map<string, Row>();
  const pick = (row: Row, select?: Record<string, boolean>) => {
    const copy = structuredClone(row);
    if (!select) return copy;
    return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, copy[k]]));
  };
  const matches = (row: Row, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && "lt" in v ? row[k] < v.lt : row[k] === v
    );
  return {
    rows,
    async create({ data }: { data: Row }) {
      const now = new Date();
      const row = { cwd: "/app", envOverrides: {}, history: [], buffer: "", outputSeq: 0, version: 0, lastActivityAt: now, createdAt: now, ...data };
      rows.set(row.id, row);
      return structuredClone(row);
    },
    async findUnique({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) {
      const row = rows.get(where.id);
      return row ? pick(row, select) : null;
    },
    async updateMany({ where, data }: { where: Record<string, any>; data: Record<string, any> }) {
      let count = 0;
      for (const row of rows.values()) {
        if (matches(row, where)) {
          Object.assign(row, structuredClone(data));
          count += 1;
        }
      }
      return { count };
    },
    async deleteMany({ where }: { where: Record<string, any> }) {
      let count = 0;
      for (const [id, row] of rows) {
        if (matches(row, where)) {
          rows.delete(id);
          count += 1;
        }
      }
      return { count };
    },
  };
}
