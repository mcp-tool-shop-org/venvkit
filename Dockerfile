FROM node:22-slim AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/map_cli.js"]
CMD ["--help"]
