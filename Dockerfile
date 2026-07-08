# Dockerfile commun à tous les services NestJS du monorepo.
# Usage : docker build --build-arg SERVICE=auth-service -t esfl/auth-service .
FROM node:24-alpine AS build
ARG SERVICE
RUN corepack enable pnpm
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/${SERVICE} ./apps/${SERVICE}

RUN pnpm install --frozen-lockfile --filter "@esfl/${SERVICE}..."
RUN if [ -f "apps/${SERVICE}/prisma/schema.prisma" ]; then \
      cd "apps/${SERVICE}" && pnpm exec prisma generate; \
    fi
RUN pnpm --filter @esfl/contracts build && pnpm --filter "@esfl/${SERVICE}" build

FROM node:24-alpine AS runtime
ARG SERVICE
ENV NODE_ENV=production
RUN corepack enable pnpm
WORKDIR /repo
COPY --from=build /repo ./
WORKDIR /repo/apps/${SERVICE}
# Applique les migrations du service (si schéma Prisma) puis démarre.
CMD ["sh", "-c", "if [ -f prisma/schema.prisma ]; then pnpm exec prisma migrate deploy; fi && node dist/main.js"]
