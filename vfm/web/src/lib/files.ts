import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { API_BASE_URL, apiText, ApiProblem } from './api';
import { api, errorMessage } from './client';

/**
 * Velero's own files for a backup or restore (log, results, resource list, ...).
 * The control plane holds a saved copy for a while; when there is none the page asks
 * the agent to fetch it and follows that command until it ends.
 */
export type FileKind = 'backups' | 'restores';

/** `logs`, or `details/<part>` — the path below the object. */
export type FilePart = 'logs' | `details/${string}`;

interface FetchResponse {
  state: 'cached' | 'fetching';
  command?: { id: string; status: string; errorMessage: string | null };
}

interface CommandState {
  id: string;
  status: string;
  errorMessage: string | null;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

export function fileUrl(
  orgId: string,
  clusterId: string,
  kind: FileKind,
  name: string,
  part: FilePart,
): string {
  return `/orgs/${orgId}/clusters/${clusterId}/${kind}/${encodeURIComponent(name)}/${part}`;
}

/** An absolute-path URL for a plain `<a href>` download (the session cookie authenticates it). */
export const downloadHref = (path: string): string => `${API_BASE_URL}${path}?download=1`;

export type FileState =
  | { phase: 'loading' }
  | { phase: 'forbidden'; message: string }
  | { phase: 'error'; message: string }
  | { phase: 'empty' }
  | { phase: 'fetching'; status: string }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; text: string; fetchedAt: string | null; expiresAt: string | null };

export function useFile(
  orgId: string,
  clusterId: string,
  kind: FileKind,
  name: string,
  part: FilePart,
  enabled = true,
): { state: FileState; fetch: (refresh: boolean) => void; busy: boolean; path: string } {
  const path = fileUrl(orgId, clusterId, kind, name, part);
  const client = useQueryClient();
  const [commandId, setCommandId] = useState<string | undefined>();
  const key = ['org', orgId, 'cluster', clusterId, 'file', kind, name, part];

  const held = useQuery({
    queryKey: key,
    enabled,
    retry: (count, error) => !(error instanceof ApiProblem) && count < 2,
    queryFn: ({ signal }) => apiText(path, { signal }),
  });

  const command = useQuery<CommandState>({
    queryKey: ['org', orgId, 'cluster', clusterId, 'command', commandId],
    enabled: commandId !== undefined,
    // A fetch lasts seconds; keep following it if the user looks at another tab meanwhile.
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      query.state.data !== undefined && TERMINAL.has(query.state.data.status) ? false : 1000,
    queryFn: ({ signal }) =>
      api<CommandState>(`/orgs/${orgId}/clusters/${clusterId}/commands/${commandId ?? ''}`, {
        signal,
      }),
  });

  const request = useMutation({
    mutationFn: (refresh: boolean) =>
      api<FetchResponse>(`${path}${refresh ? '?refresh=true' : ''}`, { method: 'POST', body: {} }),
    onSuccess: (response) => {
      if (response.state === 'cached' || response.command === undefined) {
        setCommandId(undefined);
        void client.invalidateQueries({ queryKey: key });
      } else {
        setCommandId(response.command.id);
      }
    },
  });

  const commandStatus = command.data?.status;
  const finished = commandStatus !== undefined && TERMINAL.has(commandStatus);
  useEffect(() => {
    if (commandId !== undefined && commandStatus === 'SUCCEEDED') {
      // The file is stored before the command is marked finished, so one read is enough.
      setCommandId(undefined);
      void client.invalidateQueries({ queryKey: key });
    }
    // `key` is derived from the props below; listing them is the same dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandId, commandStatus, client, orgId, clusterId, kind, name, part]);

  let state: FileState;
  if (request.isError) {
    state = forbiddenOrError(request.error);
  } else if (commandId !== undefined && finished && commandStatus !== 'SUCCEEDED') {
    state = {
      phase: 'failed',
      message:
        command.data?.errorMessage ??
        (commandStatus === 'TIMED_OUT'
          ? 'The agent did not answer in time. Is it connected?'
          : 'The fetch did not complete.'),
    };
  } else if (commandId !== undefined || request.isPending) {
    state = { phase: 'fetching', status: commandStatus ?? 'QUEUED' };
  } else if (held.isError) {
    state = forbiddenOrError(held.error);
  } else if (held.isPending) {
    state = { phase: 'loading' };
  } else if (held.data === null) {
    state = { phase: 'empty' };
  } else {
    state = { phase: 'ready', ...held.data };
  }

  return {
    state,
    path,
    busy: request.isPending || (commandId !== undefined && !finished),
    fetch: (refresh) => {
      setCommandId(undefined);
      request.mutate(refresh);
    },
  };
}

function forbiddenOrError(error: unknown): FileState {
  if (error instanceof ApiProblem && error.status === 403) {
    return { phase: 'forbidden', message: errorMessage(error) };
  }
  if (error instanceof ApiProblem && error.status === 404) {
    return { phase: 'error', message: 'This object was not found.' };
  }
  return { phase: 'error', message: errorMessage(error) };
}
