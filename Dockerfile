FROM node:24.16-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.16-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8788 DB_PATH=/data/quota-pilot.sqlite
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/client ./dist/client
COPY --from=build /app/server ./server
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8788
CMD ["node", "--import", "tsx", "server/node.ts"]
