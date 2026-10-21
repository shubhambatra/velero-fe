import type { PrismaService } from '../prisma/prisma.service';

/** Rows per DELETE, so no statement holds a lock on the audit table for long. */
export const AUDIT_DELETE_BATCH = 5_000;

/**
 * Deletes audit events up to `cutoff` for one organization (or those with no organization).
 *
 * This is the one place raw SQL touches tenant data, and the only code allowed to delete from
 * `audit_events` (`org-scope.test.ts` pins it). The table is append-only: a trigger refuses every
 * UPDATE and DELETE except from the `vfm_audit_retention` role (ADR-013), so the statement runs after
 * `SET LOCAL ROLE`. If this connection's user may not take that role, Postgres refuses and nothing is
 * deleted: that is the safe direction, and it is how an installation keeps the application unable to
 * erase its own trail (run the CLI `dist/retention.js` with a separate login that is a member instead).
 *
 * Org scoping is an explicit argument of the statement, not left to a client extension that cannot see raw SQL.
 */
export async function deleteAuditUpTo(
  prisma: PrismaService,
  orgId: string | null,
  cutoff: Date,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE vfm_audit_retention`;
      return orgId === null
        ? tx.$executeRaw`DELETE FROM audit_events WHERE id IN (
            SELECT id FROM audit_events WHERE org_id IS NULL AND created_at <= ${cutoff} LIMIT ${AUDIT_DELETE_BATCH})`
        : tx.$executeRaw`DELETE FROM audit_events WHERE id IN (
            SELECT id FROM audit_events WHERE org_id = ${orgId}::uuid AND created_at <= ${cutoff} LIMIT ${AUDIT_DELETE_BATCH})`;
    });
    total += deleted;
    if (deleted < AUDIT_DELETE_BATCH) {
      return total;
    }
  }
}
