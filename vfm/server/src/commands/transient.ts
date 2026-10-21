/**
 * Secret material that rides along with a command but is never stored with it: the
 * command row holds a redacted payload, and this is kept in memory only, until the
 * command finishes or its deadline passes (PLAN.md §6, §12.1).
 */
export interface Transient {
  credential?: Buffer;
}

/** A command needs secret material that this process no longer holds (a restart, or another replica). */
export class TransientUnavailableError extends Error {
  constructor() {
    super(
      'the credential is no longer held by the control plane; submit the change again with the credential',
    );
  }
}
