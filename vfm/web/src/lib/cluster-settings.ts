/** The cluster's Grafana link, built from the template an admin set (PLAN.md section 11.1, cluster Settings). */

/**
 * `{cluster}` becomes the cluster's name and `{clusterId}` its id, each URL-encoded. Only http and
 * https templates are used: the template is typed by an administrator, and a `javascript:` link
 * must never become a clickable one.
 */
export function grafanaUrl(
  template: string | null | undefined,
  cluster: { id: string; name: string },
): string | null {
  if (template === null || template === undefined || template.trim() === '') {
    return null;
  }
  const filled = template
    .replaceAll('{clusterId}', encodeURIComponent(cluster.id))
    .replaceAll('{cluster}', encodeURIComponent(cluster.name));
  try {
    const url = new URL(filled);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** One `key=value` per line. Blank lines are ignored; a line without `=` is an error the form can show. */
export function parseLabels(text: string): { labels: Record<string, string> } | { error: string } {
  const labels: Record<string, string> = {};
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const at = line.indexOf('=');
    if (at <= 0) {
      return { error: `Line ${String(index + 1)} is not key=value.` };
    }
    labels[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  if (Object.keys(labels).length > 50) {
    return { error: 'At most 50 labels.' };
  }
  return { labels };
}

export const formatLabels = (labels: Record<string, string> | undefined): string =>
  Object.entries(labels ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
