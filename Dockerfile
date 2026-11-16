# syntax=docker/dockerfile:1

# ---- Build: bundle the server into a single file ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build.mjs

# ---- Run ----
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/dist/server.mjs /app/dist/server.mjs.map ./
# The fallback catalog the server starts from until the live feed has been downloaded.
COPY data/sessions.snapshot.json ./data/sessions.snapshot.json
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "server.mjs"]
