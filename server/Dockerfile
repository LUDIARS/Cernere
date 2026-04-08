FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install --production=false
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json* /app/pnpm-lock.yaml* ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/index.js"]
