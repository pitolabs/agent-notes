# agent-notes as a container: the MCP server over HTTP on port 8070, the notes folder mounted at /notes, the index in
# /data (a volume; rebuilt from the folder when removed). Embeddings and the token come from the environment
# (EMBEDDINGS_*, OPENROUTER_API_KEY, AGENT_NOTES_TOKEN); without EMBEDDINGS_PROVIDER, search is by words.
#   docker build -t agent-notes .
#   docker run -v ~/notes:/notes -v agent-notes-data:/data -p 8070:8070 -e AGENT_NOTES_TOKEN=... agent-notes
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
RUN npm install -g --no-audit --no-fund bun@1.4.4
COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src ./src
RUN bun run build \
    && rm -rf node_modules \
    && bun install --frozen-lockfile --production --ignore-scripts

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN install -d -o 1000 -g 1000 /data /notes
USER 1000:1000
EXPOSE 8070
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8070/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["mcp", "--http", "--host", "0.0.0.0", "--port", "8070", "--dir", "/notes", "--db", "file:/data/notes.db"]
