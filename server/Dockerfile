# syntax=docker/dockerfile:1.7
# Official multi-platform index digests, verified 2026-10-19.
ARG NODE_IMAGE=node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
ARG RUST_IMAGE=rust:bookworm@sha256:e12566d5abc17a0da741628782cdb504b68b8961f5bfcf677936bf3e8b32de29

FROM ${NODE_IMAGE} AS node-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts/build-server.mjs scripts/build-server.mjs
COPY src/core src/core
COPY src/shared src/shared
COPY server/src server/src
RUN node scripts/build-server.mjs && npm prune --omit=dev --ignore-scripts

FROM ${RUST_IMAGE} AS native-build
WORKDIR /build
COPY native/arale-native/Cargo.toml native/arale-native/Cargo.lock ./
COPY native/arale-native/src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --locked --release

FROM ${PYTHON_IMAGE} AS ocr-build
COPY server/docker/requirements-linux.lock /tmp/requirements-linux.lock
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r /tmp/requirements-linux.lock
# Local verified weights make repeat builds offline; clean clones download only a
# SHA256-pinned desktop archive as a source for platform-neutral model files.
COPY engines/arale_onnx_v1/ /engine-input/
COPY server/docker/install-models.py /tmp/install-models.py
RUN python /tmp/install-models.py --source /engine-input/models \
    --manifest /engine-input/model-manifest.json \
    --release /engine-input/dist/catalog-entry-darwin-arm64.json \
    --target /opt/arale/ocr/models
COPY engines/arale_onnx_v1/python/ /opt/arale/ocr/ocr/
COPY engines/arale_onnx_v1/model-manifest.json /opt/arale/ocr/model-manifest.json
COPY server/docker/extension-linux.json /opt/arale/ocr/extension.json
COPY server/docker/verify-runtime.py /opt/arale/ocr/verify-runtime.py
COPY engines/LICENSE /opt/arale/licenses/OCR-GPL-3.0.txt
COPY engines/arale_onnx_v1/THIRD_PARTY.md /opt/arale/licenses/OCR-THIRD-PARTY.md

FROM ${PYTHON_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 arale && useradd --uid 1000 --gid arale --no-create-home arale \
    && mkdir /data /library /app && chown arale:arale /data /library
COPY --from=node-build /usr/local/bin/node /usr/local/bin/node
COPY --from=node-build /build/dist-server/ /app/
COPY --from=node-build /build/node_modules/ /app/node_modules/
COPY --from=native-build /build/target/release/arale-native /usr/local/bin/arale-native
COPY --from=ocr-build /usr/local/lib/python3.12/site-packages/ /usr/local/lib/python3.12/site-packages/
COPY --from=ocr-build /opt/arale/ /opt/arale/
COPY server/docker/requirements-linux.lock /opt/arale/ocr/requirements-linux.lock
COPY server/docker/entrypoint.sh /usr/local/bin/arale-entrypoint
# Build contexts may come from private source archives with umask 077. Runtime
# assets are public code/models and must remain readable by the non-root user.
RUN chmod -R a+rX /app /opt/arale \
    && chmod 755 /usr/local/bin/arale-entrypoint /usr/local/bin/arale-native
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=4 ARALE_OCR_THREADS=4 \
    ARALE_SERVER_HOST=0.0.0.0 ARALE_SERVER_PORT=3737 ARALE_SERVER_LOCK_WAIT=1 \
    ARALE_SERVER_DATA=/data ARALE_SERVER_LIBRARY=/library \
    ARALE_OCR_MANIFEST=/opt/arale/ocr/extension.json ARALE_EXTRACTOR=/usr/local/bin/arale-native
WORKDIR /app
USER 1000:1000
EXPOSE 3737
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3737/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/arale-entrypoint"]
