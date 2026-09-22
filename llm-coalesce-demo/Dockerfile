FROM node:20-alpine

WORKDIR /app

COPY package.json ./
# The tarball dependency (file:./vendor-packages/...) must exist before
# `npm install` runs, since npm reads it directly from disk at that path.
COPY vendor-packages ./vendor-packages
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
