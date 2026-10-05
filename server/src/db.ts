import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { env } from './env.js'

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL })
})

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
export type Db = typeof prisma | Tx

export * from '../generated/prisma/client.js'
