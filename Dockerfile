# No npm dependencies at runtime: SQLite, fetch and WebCrypto are built into Node.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/x-bookmarks.db NODE_NO_WARNINGS=1
COPY package.json ./
COPY src ./src
COPY site ./site
COPY migrations ./migrations
COPY scripts/apply-sql.mjs ./scripts/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "src/node.js"]
