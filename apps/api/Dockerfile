FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
COPY infra/postgres/migrations ./infra/postgres/migrations
RUN pnpm install --frozen-lockfile --filter @work-chat/api...
RUN pnpm --filter @work-chat/contracts build && pnpm --filter @work-chat/api build

FROM node:24-alpine
WORKDIR /repo
ENV NODE_ENV=production
RUN corepack enable && corepack install --global pnpm@10.33.0
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts ./packages/contracts
COPY --from=build /repo/apps/api ./apps/api
COPY --from=build /repo/infra/postgres/migrations ./infra/postgres/migrations
COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml /repo/tsconfig.base.json ./
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
