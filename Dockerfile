FROM node:20-alpine

WORKDIR /app

# Install native dependencies required for better-sqlite3 compilation
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "server.js"]
