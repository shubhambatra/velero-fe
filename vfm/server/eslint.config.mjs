import base from '../eslint.config.mjs';

export default [
  ...base,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      // Nest's DI relies on decorator metadata and parameter properties, which
      // the strict rules misread as unnecessary.
      '@typescript-eslint/parameter-properties': 'off',
      // Controllers and providers are instantiated by the framework.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
