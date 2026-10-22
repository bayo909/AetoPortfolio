FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/data SEED_DEMO=0 PORT=3000
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "platform/server.js"]
