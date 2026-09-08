FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 python3-pip ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN chown bun:bun /app
COPY --chown=bun:bun . .
USER bun
RUN bun install --frozen-lockfile
CMD ["bun", "run", "demo"]
