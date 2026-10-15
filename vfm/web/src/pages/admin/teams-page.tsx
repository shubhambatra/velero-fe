import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field, inputClass } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import type { Member, Team, TeamMember } from '@/lib/types';

export function TeamsPage({ orgId }: { orgId: string }): ReactElement {
  const client = useQueryClient();
  const teamsKey = ['org', orgId, 'teams'];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const teams = useQuery({
    queryKey: teamsKey,
    queryFn: ({ signal }) => api<{ teams: Team[] }>(`/orgs/${orgId}/teams`, { signal }),
  });
  const create = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/teams`, {
        method: 'POST',
        body: { name, ...(description.trim() === '' ? {} : { description }) },
      }),
    onSuccess: async () => {
      setName('');
      setDescription('');
      await client.invalidateQueries({ queryKey: teamsKey });
    },
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Teams</h1>

      <Card>
        <CardHeader>
          <CardTitle>New team</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field
              label="Name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            <Field
              label="Description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Create team
            </Button>
          </form>
          <ErrorNote message={create.isError ? errorMessage(create.error) : undefined} />
        </CardContent>
      </Card>

      <ErrorNote message={teams.isError ? errorMessage(teams.error) : undefined} />
      {teams.data?.teams.length === 0 && (
        <p className="text-sm text-muted-foreground">No teams yet. Create one above.</p>
      )}
      {teams.data?.teams.map((team) => (
        <TeamCard key={team.id} orgId={orgId} team={team} />
      ))}
    </div>
  );
}

function TeamCard({ orgId, team }: { orgId: string; team: Team }): ReactElement {
  const client = useQueryClient();
  const teamsKey = ['org', orgId, 'teams'];
  const membersKey = ['org', orgId, 'teams', team.id, 'members'];
  const [name, setName] = useState(team.name);
  const [userId, setUserId] = useState('');

  const members = useQuery({
    queryKey: membersKey,
    queryFn: ({ signal }) =>
      api<{ members: TeamMember[] }>(`/orgs/${orgId}/teams/${team.id}/members`, { signal }),
  });
  const orgMembers = useQuery({
    queryKey: ['org', orgId, 'members'],
    queryFn: ({ signal }) => api<{ members: Member[] }>(`/orgs/${orgId}/members`, { signal }),
  });

  const rename = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/teams/${team.id}`, { method: 'PATCH', body: { name } }),
    onSuccess: () => client.invalidateQueries({ queryKey: teamsKey }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/teams/${team.id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: teamsKey }),
  });
  const add = useMutation({
    mutationFn: () => api(`/orgs/${orgId}/teams/${team.id}/members/${userId}`, { method: 'PUT' }),
    onSuccess: async () => {
      setUserId('');
      await client.invalidateQueries({ queryKey: membersKey });
      await client.invalidateQueries({ queryKey: teamsKey });
    },
  });
  const drop = useMutation({
    mutationFn: (id: string) =>
      api(`/orgs/${orgId}/teams/${team.id}/members/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: membersKey });
      await client.invalidateQueries({ queryKey: teamsKey });
    },
  });

  const inTeam = new Set(members.data?.members.map((m) => m.id));
  const candidates = orgMembers.data?.members.filter((m) => !inTeam.has(m.userId)) ?? [];
  const failure = [rename, remove, add, drop].find((m) => m.isError)?.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{team.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {team.description !== null && <p className="text-muted-foreground">{team.description}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Team name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Button
            disabled={name.trim() === '' || name === team.name || rename.isPending}
            onClick={() => {
              rename.mutate();
            }}
          >
            Rename
          </Button>
          <Button
            aria-label={`Delete team ${team.name}`}
            onClick={() => {
              remove.mutate();
            }}
          >
            Delete team
          </Button>
        </div>

        <ul className="flex flex-col gap-1">
          {members.data?.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3">
              <span>{m.email}</span>
              <Button
                aria-label={`Remove ${m.email} from ${team.name}`}
                onClick={() => {
                  drop.mutate(m.id);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`add-${team.id}`} className="text-sm font-medium">
              Add member
            </label>
            <select
              id={`add-${team.id}`}
              className={inputClass}
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
              }}
            >
              <option value="">Choose a member</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.email}
                </option>
              ))}
            </select>
          </div>
          <Button
            disabled={userId === '' || add.isPending}
            onClick={() => {
              add.mutate();
            }}
          >
            Add
          </Button>
        </div>
        <ErrorNote message={failure === undefined ? undefined : errorMessage(failure)} />
      </CardContent>
    </Card>
  );
}
