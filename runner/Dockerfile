# syntax=docker/dockerfile:1
# Syncbay Containerized Runner Agent Daemon
# Multi-stage image packaging Node.js, Docker CLI, Nixpacks, Git, and Bash

# ─── Stage 1: Binary Toolchain Installer ──────────────────────────────────────
FROM node:20-bookworm-slim AS toolchain

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tar \
    gzip \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Nixpacks binary
ARG NIXPACKS_VERSION=1.30.0
RUN curl -sSL https://nixpacks.com/install.sh | bash || \
    (curl -sSL -o /tmp/nixpacks.tar.gz "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/nixpacks-v${NIXPACKS_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    && tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/nixpacks \
    && rm -f /tmp/nixpacks.tar.gz)

# Install Docker CLI static binary
ARG DOCKER_VERSION=26.1.4
RUN curl -sSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp/ \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && chmod +x /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz

# Install Cloudflare Tunnel agent (cloudflared)
RUN curl -sSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o /usr/local/bin/cloudflared \
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

# Verify installed binaries
RUN docker --version && nixpacks --version && git --version && bash --version

# Setup workspace and runner directories
ENV WORKSPACE_DIR=/workspace
ENV APP_DIR=/app
RUN mkdir -p ${WORKSPACE_DIR} ${APP_DIR}

WORKDIR ${APP_DIR}

# Copy runner application files
COPY package.json ./
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
ENTRYPOINT ["node", "src/index.js"]
