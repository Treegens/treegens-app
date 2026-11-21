# syntax=docker/dockerfile:1
# GrowSigning in one container: the web app, the API and the timer are one Node process, the database is one SQLite
# file and the stored files are a folder, both in the one volume at /data.
#
#   docker build -t growsigning .
#   docker build -t growsigning --build-arg WITH_LIBREOFFICE=1 .     with LibreOffice, for CONVERTER=soffice
#
# The base image is a build argument so that you can pin it to the digest you have checked. The tag below moves when
# Node publishes a patch release; a build for a record (source escrow, a release you sign) names the digest:
#   docker buildx imagetools inspect node:24-bookworm-slim          prints the digest
#   docker build --build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<digest> --build-arg SOURCE_DATE_EPOCH=<seconds> .
# docs/runbooks.md, "Rebuilding the same image", has the whole list.
#
# Node 24 is the long-term-support line. Node 22 (the oldest this code runs on, see "engines" in package.json) leaves
# support on 30 April 2027, so the image does not start there.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---- Build: install, make the fonts and the bill of materials, compile -------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# npm ci runs scripts/copy-assets.mjs (the "postinstall" script), which copies the PDF viewer and builds the fonts for
# signed PDFs out of node_modules. After this step nothing needs the network again.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
# With SOURCE_DATE_EPOCH the bill of materials carries that time and a serial number made from its contents.
ARG SOURCE_DATE_EPOCH
# "npm run build" first writes public/security/sbom.json and third-party-licences.txt (scripts/sbom.mjs) and stops the
# build when a package has a licence nobody has read. Then the development packages and the build cache go.
RUN npm run build && npm prune --omit=dev && rm -rf .next/cache

# ---- Run ----------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
# LibreOffice turns Word, Excel and PowerPoint files into PDF on this machine (CONVERTER=soffice). It is large
# (about 500 MB), so it is only put in when asked for. Without it, set no CONVERTER and office files are simply not
# taken: the upload says that it needs a PDF.
# The server takes the network away from LibreOffice with "unshare -rn". In a container run with every capability
# dropped and no new privileges (the compose example, the Helm chart) that is not permitted, so LibreOffice has the
# network the container has and the server log says so. Deny egress in the network around the container.
ARG WITH_LIBREOFFICE=0
RUN if [ "$WITH_LIBREOFFICE" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu fonts-liberation2 fonts-noto-core \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATA_DIR=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Everything under /app belongs to root and is only read by the server. src/ and README.md are there because the
# scripts (backup, restore, encrypt-files) and the help chat read them.
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.mjs /app/README.md ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/assets ./assets
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
COPY --from=build /app/docs ./docs
# The only places the server writes: /data (the volume), the framework's cache and /tmp. With a read-only root file
# system (docker-compose.example.yml and the Helm chart both set it) the last two are small in-memory mounts.
RUN mkdir -p /data /app/.next/cache && chown node:node /data /app/.next/cache
# The image's own unprivileged user (uid 1000). Nothing in the container runs as root.
USER node
VOLUME ["/data"]
EXPOSE 3000
# 200 only when the database opens, /data can be written to, more than 1 GB is free, storing files is not stopped and
# the timer ran in the last 30 minutes (src/server/selfhost.ts). It asks this machine only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start"]
