import { execSync } from 'node:child_process'
import pg from 'pg'

// Create the test database if needed and bring it to the latest migration.
export default async function setup() {
  const url = new URL(process.env.DATABASE_URL!)
  const name = url.pathname.slice(1)
  if (!/^bp_test[a-z0-9_]*$/.test(name)) throw new Error(`Refusing to run tests against database "${name}"`)
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${name}"`)
  await client.end()
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env } })
}
