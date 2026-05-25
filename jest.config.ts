import type { Config } from 'jest'

const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  // setupFiles runs BEFORE the test framework loads. This is the only reliable
  // place to set process.env.TZ — Node caches the timezone at startup, so
  // setting it inside a test file is too late on Node 22+ and on UTC-default
  // CI runners. Scheduler DST tests depend on this.
  setupFiles: ['<rootDir>/jest.setup-tz.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.node.json' }]
  },
  moduleNameMapper: {
    '^@shared/(.*)$':    '<rootDir>/src/shared/$1',
    '^electron$':        '<rootDir>/__mocks__/electron.ts',
    '^electron-store$':  '<rootDir>/__mocks__/electron-store.ts'
  }
}

export default config
