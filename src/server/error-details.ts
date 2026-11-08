/**
 * Structured details for a tRPC error. Pass an `ErrorDetails` as the TRPCError `cause` and the
 * error formatter (`trpc.ts`) copies `details` into `error.data.details` for the client, e.g.
 * `{ existingProjectId }` on a duplicate project name.
 */
export class ErrorDetails extends Error {
  constructor(
    message: string,
    readonly details: Record<string, string | number | boolean | null>
  ) {
    super(message);
    this.name = "ErrorDetails";
  }
}
