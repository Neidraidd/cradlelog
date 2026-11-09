FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data NODE_NO_WARNINGS=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js VERSION ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/version || exit 1
CMD ["node", "server.js"]
