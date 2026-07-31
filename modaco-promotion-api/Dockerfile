# syntax=docker/dockerfile:1

FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY lambdas ./lambdas
COPY scripts ./scripts
COPY tests ./tests

RUN npm run build

FROM node:24-alpine

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma

USER node

EXPOSE 3000

CMD ["node", "dist/src/server.js"]
