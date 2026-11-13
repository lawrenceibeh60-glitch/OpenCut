# Build the Rust renderer as a browser WebAssembly package.
FROM rust:1-bookworm AS wasm-builder
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates pkg-config build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
RUN rustup target add wasm32-unknown-unknown
WORKDIR /app
COPY . .
WORKDIR /app/crates/kyrocut-render
RUN wasm-pack build --target web --out-dir ../../apps/web/src/generated/renderer-wasm --out-name kyrocut_renderer --release

# Build and run the TanStack Start/Nitro web application with Bun,
# which is the package manager used by this repository.
FROM oven/bun:1 AS web
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY --from=wasm-builder /app/bunfig.toml ./bunfig.toml
WORKDIR /app/apps/web
COPY --from=wasm-builder /app/apps/web ./
RUN bun install --no-progress
RUN bun run test
RUN bun run check
RUN bun run build
EXPOSE 3000
CMD ["bun", "run", "start"]
