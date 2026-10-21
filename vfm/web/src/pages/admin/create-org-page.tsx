import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useSession } from '@/lib/session';

const toSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * Create an organization (POST /orgs). Platform administrators only: §8.1 has
 * the platform admin bootstrap orgs, so a fresh install has nowhere else to
 * start from after first-run setup.
 */
export function CreateOrgPage(): ReactElement {
  const session = useSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      const org = await api<{ id: string }>('/orgs', { method: 'POST', body: { name, slug } });
      // Make it the active org so the admin pages work straight away.
      await api('/me/active-org', { method: 'POST', body: { orgId: org.id } });
    },
    onSuccess: async () => {
      await client.invalidateQueries();
      await navigate({ to: '/admin/members' });
    },
  });

  if (session.status === 'ready' && !session.user.isPlatformAdmin) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>Not available</CardTitle>
          <CardDescription>Only platform administrators create organizations.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Create an organization</h1>
      <Card>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field
              label="Name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) {
                  setSlug(toSlug(e.target.value));
                }
              }}
            />
            <Field
              label="Slug"
              hint="Lowercase letters, digits and hyphens. Used on the sign-in page."
              required
              value={slug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
            />
            <ErrorNote message={create.isError ? errorMessage(create.error) : undefined} />
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Create organization
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
