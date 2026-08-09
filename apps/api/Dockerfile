FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @work-chat/api...
RUN pnpm --filter @work-chat/contracts build && pnpm --filter @work-chat/api build

FROM node:24-alpine
WORKDIR /repo
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts ./packages/contracts
COPY --from=build /repo/apps/api ./apps/api
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

