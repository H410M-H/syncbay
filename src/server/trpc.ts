import { initTRPC, TRPCError } from "@trpc/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import superjson from "superjson";
import { ZodError } from "zod";
import { ErrorDetails } from "./error-details";

/**
 * tRPC Context — created per request.
 * DR-01: All queries scoped through session to enforce workspace isolation.
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
  const session = await getServerSession(authOptions);
  return {
    db,
    session,
    headers: opts.headers,
  };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
        details: error.cause instanceof ErrorDetails ? error.cause.details : null,
      },
    };
  },
});

/** Enforces authenticated caller — all protected procedures must use this */
const suspendedCache = new Map<string, { suspended: boolean; at: number }>();
const SUSPENDED_TTL_MS = 30_000;

/** Whether staff suspended this user (cached 30 s per instance). */
async function isUserSuspended(userId: string): Promise<boolean> {
  const hit = suspendedCache.get(userId);
  if (hit && Date.now() - hit.at < SUSPENDED_TTL_MS) return hit.suspended;
  const row = await db.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } }).catch(() => null);
  const suspended = Boolean(row?.suspendedAt);
  suspendedCache.set(userId, { suspended, at: Date.now() });
  if (suspendedCache.size > 5000) suspendedCache.delete(suspendedCache.keys().next().value as string);
  return suspended;
}

const enforceUserIsAuthed = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const userId = (ctx.session.user as { id?: string }).id;
  if (userId && (await isUserSuspended(userId))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This account is suspended. Contact support@syncbay.app." });
  }
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(enforceUserIsAuthed);
export const createTRPCRouter = t.router;
