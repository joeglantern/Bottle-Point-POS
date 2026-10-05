FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# dev dependencies are needed to build (typescript) and to run the seed (tsx)
RUN npm ci --include=dev --no-audit --no-fund
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate
COPY src ./src
RUN npx tsc -p tsconfig.json
USER node
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]
