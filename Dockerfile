# Designotron relay: online multiplayer rooms plus the editor, in one small image.
#   docker build -t designotron-relay .
#   docker run -p 8080:8080 -v designotron-rooms:/data designotron-relay

FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# The WebAssembly engine is prebuilt in web/src/wasm/pkg, so no Rust is needed here.
RUN npx vite build

FROM rust:1-bookworm AS relay
WORKDIR /src
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY crates/ crates/
RUN cargo build --release -p designotron-relay

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 relay && mkdir -p /data && chown relay /data
COPY --from=relay /src/target/release/designotron-relay /usr/local/bin/designotron-relay
COPY --from=web /src/web/dist /app/web
ENV PORT=8080 DESIGNOTRON_STATIC=/app/web DESIGNOTRON_DATA=/data RUST_LOG=info
USER relay
VOLUME /data
EXPOSE 8080
CMD ["designotron-relay"]
