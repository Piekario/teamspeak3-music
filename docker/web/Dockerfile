# Builds the React panel and serves it as static files. Multi-arch: nothing here needs
# emulation.
FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/frontend/package.json packages/frontend/
RUN pnpm install --frozen-lockfile --filter @tsmusic/shared --filter @tsmusic/frontend

COPY packages/shared packages/shared
COPY packages/frontend packages/frontend
RUN pnpm --filter @tsmusic/shared build && pnpm --filter @tsmusic/frontend build

FROM nginx:1.27-alpine

COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
