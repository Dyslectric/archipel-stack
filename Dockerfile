FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY client ./client
COPY scripts ./scripts
COPY migrations ./migrations
COPY test ./test
COPY e2e ./e2e
COPY playwright.config.ts ./
RUN npm run build && npm run build:server

FROM build AS browser-tests
RUN npx playwright install --with-deps chromium
CMD ["npm", "run", "test:browser"]

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 DEV_AUTH=false DATABASE_PATH=/app/data/archipel.sqlite
WORKDIR /app
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/build/src ./src
COPY --from=build /app/build/scripts ./scripts
COPY --from=build /app/dist/client ./dist/client
COPY migrations ./migrations
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
EXPOSE 8788
CMD ["node", "src/server.js"]
