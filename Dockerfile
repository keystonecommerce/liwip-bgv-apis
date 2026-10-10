FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY apps ./apps
COPY scripts ./scripts
COPY smoke-tests ./smoke-tests

RUN npm run db:generate && npm run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist

EXPOSE 3001
CMD ["sh", "-c", "npm run db:deploy && npm run start:prod"]
