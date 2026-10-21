import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

import base from '../eslint.config.mjs';

export default [
  ...base,

  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        // Re-pointed at this package so type-aware linting resolves against
        // web/tsconfig.json (DOM libs, JSX) and not the root config.
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Promoted from the plugin's default 'warn': a stale closure in a
      // polling component (the health indicator, later the log tail) is a
      // real defect, not a style preference.
      'react-hooks/exhaustive-deps': 'error',
      // The plugin's `recommended` preset also enables the React Compiler
      // rule set. Those are deliberately left off until the compiler itself
      // is adopted, so lint results cannot change under us before then.
    },
  },

  {
    // Keeps every module hot-reloadable in dev, which matters for a UI this
    // size (PLAN.md §14.1 runs the web app with hot reload).
    ...reactRefresh.configs.vite,
    files: ['src/**/*.tsx'],
    rules: {
      ...reactRefresh.configs.vite.rules,
      // The UI primitives follow the shadcn convention of exporting a
      // `cva` variant table beside the component. A constant export does not
      // break fast refresh, so allow it rather than splitting every primitive
      // across two files.
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },

  {
    // Route modules export a TanStack Router route object, not a component.
    // Fast refresh has nothing to preserve in them, and splitting the route
    // from the component it renders would make the routing harder to follow.
    files: ['src/routes/**/*.tsx', 'src/router.ts'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  {
    // The root config grants this relaxation to *.test.ts; component tests are
    // .tsx and need it for the same reason — Testing Library and mocked
    // globals are loosely typed at the boundary.
    files: ['src/**/*.test.tsx', 'src/test/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
];
