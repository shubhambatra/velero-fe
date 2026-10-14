import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppProviders } from '@/app/providers';
import { router } from '@/router';

import '@/styles/globals.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  // Nothing can be rendered, including an error boundary, so fail loudly
  // instead of leaving a blank page with a silent console.
  throw new Error('Mount point #root is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
