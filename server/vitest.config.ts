import { defineConfig } from 'vitest/config'

// Tests run against a real Postgres database, never the dev one.
// TEST_DB picks the database name so parallel runs do not collide:
//   TEST_DB=bp_test_sales npx vitest run test/sales.test.ts
const db = process.env.TEST_DB ?? 'bp_test'
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = `postgresql://bottlepoint:bottlepoint@127.0.0.1:5544/${db}`
process.env.MPESA_MODE = 'mock'

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      MPESA_MODE: 'mock'
    }
  }
})
