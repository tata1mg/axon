# syntax=docker/dockerfile:1.7
# Build from the repository root; see apps/backend/README.md#docker.
# Bare Wolfi base (no Python baked in)
ARG BASE_IMAGE=831059512818.dkr.ecr.ap-south-1.amazonaws.com/wolfi:20261023

# Static frontend output is architecture-independent, so build it natively.
FROM --platform=$BUILDPLATFORM node:24-alpine AS console

WORKDIR /build
RUN corepack enable

COPY apps/frontend/package.json apps/frontend/pnpm-lock.yaml apps/frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY apps/frontend/ ./
RUN cp config_template.json config.json && pnpm build

# Shared Python setup for dependency installation and runtime.
FROM --platform=linux/amd64 ${BASE_IMAGE} AS python-base

# Latest Python 3.14 from the Wolfi repo (intentionally unpinned), so every
# build picks up the newest patched 3.14 release.
RUN apk update && apk add --no-cache python-3.14 libstdc++ ca-certificates tzdata curl

# Fail the build if the interpreter or its required shared libraries are broken.
RUN python3.14 -c 'import bz2, ctypes, lzma, sqlite3, ssl, sys, zlib; assert sys.version_info[:2] == (3, 14), sys.version; print(sys.version, ssl.OPENSSL_VERSION)'

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/home/ubuntu/1mg/axon-backend/.venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
WORKDIR /home/ubuntu/1mg/axon-backend

# Resolve the virtual environment without a compiler toolchain.
FROM python-base AS builder

COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv
COPY apps/backend/pyproject.toml apps/backend/uv.lock apps/backend/README.md ./
RUN uv sync --frozen --no-dev --no-cache --python /usr/bin/python3.14

FROM python-base AS runtime

RUN addgroup -g 1001 app-group && \
    adduser -D -u 1001 -G app-group app-user && \
    mkdir -p logs && chown 1001:1001 logs

COPY --from=builder --chown=1001:1001 $VIRTUAL_ENV $VIRTUAL_ENV
COPY --chown=1001:1001 apps/backend/ .
# The backend serves the CLI's published installer from this sibling path.
COPY apps/cli/install.sh /home/ubuntu/1mg/cli/install.sh
COPY --from=console --chown=1001:1001 /build/dist ./static

RUN chmod +x deployment/*.sh
USER app-user:app-group
CMD ["./deployment/run_service.sh"]
