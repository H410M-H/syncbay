# syntax=docker/dockerfile:1
# Syncbay Containerized Runner Agent Daemon
# Multi-stage image packaging Node.js, Docker CLI, Nixpacks, Git, and Bash

# ─── Stage 1: Binary Toolchain Installer ──────────────────────────────────────
FROM node:20-bookworm-slim AS toolchain
# Set by BuildKit for the platform being built (amd64 for x86 ECS, arm64 for ARM hosts).
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tar \
    gzip \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Nixpacks binary
ARG NIXPACKS_VERSION=1.30.0
RUN case "$TARGETARCH" in arm64) A=aarch64 ;; *) A=x86_64 ;; esac && \
    curl -fsSL -o /tmp/nixpacks.tar.gz "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/nixpacks-v${NIXPACKS_VERSION}-${A}-unknown-linux-musl.tar.gz" \
    && tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/nixpacks \
    && rm -f /tmp/nixpacks.tar.gz

# Install Docker CLI static binary
ARG DOCKER_VERSION=26.1.4
RUN case "$TARGETARCH" in arm64) A=aarch64 ;; *) A=x86_64 ;; esac && \
    curl -fsSL "https://download.docker.com/linux/static/stable/${A}/docker-${DOCKER_VERSION}.tgz" -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp/ \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && chmod +x /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz

# Install the buildx CLI plugin. Docker CLI 23+ builds with BuildKit by default, and Nixpacks'
# generated Dockerfiles need BuildKit (RUN --mount=type=cache); without buildx every build fails with
# "BuildKit is enabled but the buildx component is missing or broken".
ARG BUILDX_VERSION=0.17.1
RUN mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${TARGETARCH:-amd64}" \
       -o /usr/local/lib/docker/cli-plugins/docker-buildx \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

# Install Cloudflare Tunnel agent (cloudflared)
RUN curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH:-amd64}" -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

# ─── Stage 2: Production Runner Runtime ───────────────────────────────────────
FROM node:20-bookworm-slim AS runner

# Install essential runtime tools: git, bash, curl, ssh
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    curl \
    ca-certificates \
    openssh-client \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Copy precompiled toolchain binaries from Stage 1
COPY --from=toolchain /usr/local/bin/docker /usr/local/bin/docker
COPY --from=toolchain /usr/local/bin/nixpacks /usr/local/bin/nixpacks
COPY --from=toolchain /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=toolchain /usr/local/lib/docker/cli-plugins/ /usr/local/lib/docker/cli-plugins/

# Verify installed binaries
RUN docker --version && docker buildx version && nixpacks --version && git --version && bash --version

# Setup workspace and runner directories
ENV WORKSPACE_DIR=/workspace
ENV APP_DIR=/app
RUN mkdir -p ${WORKSPACE_DIR} ${APP_DIR}

WORKDIR ${APP_DIR}

# Install the TypeScript runtime used by the source entrypoint
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/

# Environment Configuration
ENV NODE_ENV=production
ENV RUNNER_PORT=8080
ENV RUNNER_HOST=0.0.0.0
ENV PORT_RANGE_START=10000
ENV PORT_RANGE_END=60000

# Health check probing runner daemon /health endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${RUNNER_PORT}/health || exit 1

# Expose daemon management port and dynamic container port pool
EXPOSE 8080
EXPOSE 10000-60000

# Entrypoint: Start runner daemon
ENTRYPOINT ["./node_modules/.bin/tsx", "src/index.ts"]
