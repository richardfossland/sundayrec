import type { Config } from 'jest'

const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
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
