import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { buttonVariants } from '@/components/ui/button-variants';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Rendered by the root route's `notFoundComponent`, so an unknown URL keeps
 * the shell — header, navigation, theme — instead of dropping the user onto a
 * bare page with no way back.
 */
export function NotFoundPage(): ReactElement {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Page not found</h1>

      <Card>
        <CardHeader>
          <CardTitle>That URL does not exist</CardTitle>
          <CardDescription>
            It may have been a link to a page that has not shipped yet, or a mistyped address.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            Styled as a button but still an anchor: it navigates, so it must
            behave like a link for keyboard and screen-reader users.
          */}
          <Link to="/" className={buttonVariants({ variant: 'primary' })}>
            Back to the fleet overview
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
