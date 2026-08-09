FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/realtime ./apps/realtime
RUN pnpm install --frozen-lockfile --filter @work-chat/realtime...
RUN pnpm --filter @work-chat/contracts build && pnpm --filter @work-chat/realtime build

FROM node:24-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts ./packages/contracts
COPY --from=build /repo/apps/realtime ./apps/realtime
EXPOSE 3001
CMD ["node", "apps/realtime/dist/main.js"]

