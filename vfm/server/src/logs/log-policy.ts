/**
 * Whether the cluster's own agent policy (PLAN.md §5.5) would refuse a log session, read
 * from the policy the agent reported in `Hello`. The agent enforces it again itself; this
 * is the control plane saying no first, with the reason, instead of starting a session that
 * is bound to be refused.
 *
 * A missing or unreadable policy refuses nothing here, for the same reason `policyBlocks`
 * does not: the agent has the last word, and a policy this code cannot read is not evidence
 * of a restriction.
 */
export function logPolicyDenial(policy: unknown, namespace: string): string | undefined {
  const p =
    typeof policy === 'object' && policy !== null ? (policy as Record<string, unknown>) : {};
  if (p.allowLogStreaming === false) {
    return 'This cluster’s agent policy does not allow streaming logs.';
  }
  const denied = Array.isArray(p.logStreamDeniedNamespaces) ? p.logStreamDeniedNamespaces : [];
  if (denied.includes('*') || denied.includes(namespace)) {
    return `This cluster’s agent policy does not allow streaming logs from the namespace “${namespace}”.`;
  }
  return undefined;
}
