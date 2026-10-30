/* eslint-disable */
export default {
  displayName: 'velero-ui-api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // The Kubernetes client and its dependencies ship ESM only; transform them to CommonJS.
  transformIgnorePatterns: ['node_modules/(?!(@kubernetes/client-node|openid-client|jose|oauth4webapi)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/velero-ui-api',
};
