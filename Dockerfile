# Container image for the printer service (design D2 of add-docker-deployment).
# Node runs the .ts sources directly, so there is no build step: one stage
# installs the production dependencies, the runtime stage copies them with the
# sources. Configure it with env (PRINTER_IP, ACCESS_TOKEN, LISTEN_PORT, ...)
# or a config file mounted at CONFIG_PATH. The print history archive lives in
# /data (DATA_DIR); mount a named volume there to keep it across containers.

# Major from .nvmrc.
ARG NODE_IMAGE=node:26-slim

FROM ${NODE_IMAGE} AS deps
# Keep in step with "packageManager" in package.json.
ARG PNPM_VERSION=10.33.0
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# node_modules exists even while there are no production dependencies, so the
# runtime stage can always copy it.
RUN mkdir -p node_modules && pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts/healthcheck.ts ./scripts/healthcheck.ts
# The history archive (design D11 of add-print-history). An empty named volume
# mounted here takes this ownership, so the node user can write it.
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.ts"]
CMD ["node", "src/main.ts"]
