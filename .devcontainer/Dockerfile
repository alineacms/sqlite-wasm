ARG VARIANT="24-bookworm"
ARG BUN_VERSION="1.4.2"
FROM oven/bun:${BUN_VERSION} AS bun

FROM mcr.microsoft.com/devcontainers/typescript-node:${VARIANT}

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Keep the SDK checkout and compiler version pinned together. Cloning the
# moving default branch makes old compiler installations depend on the latest
# emsdk launcher (which now requires newer versions of Python).
ARG EMSCRIPTEN_VERSION="6.0.9"
ENV EMSDK=/emsdk
ENV EMSCRIPTEN_VERSION=${EMSCRIPTEN_VERSION}

RUN git clone --depth 1 --branch "${EMSCRIPTEN_VERSION}" \
        https://github.com/emscripten-core/emsdk.git "${EMSDK}" \
    && cd "${EMSDK}" \
    && ./emsdk install "${EMSCRIPTEN_VERSION}" \
    && ./emsdk activate "${EMSCRIPTEN_VERSION}" \
    && chmod -R a+rwX "${EMSDK}/upstream/emscripten/cache"

ENV PATH=${EMSDK}:${EMSDK}/upstream/emscripten:${PATH}

# Prime Emscripten's cache during the image build and verify the toolchain.
RUN printf 'int main(void) { return 0; }\n' > /tmp/emsdk-hello.c \
    && "${EMSDK}/upstream/emscripten/emcc" -c /tmp/emsdk-hello.c -o /tmp/emsdk-hello.o \
    && rm -f /tmp/emsdk-hello.c /tmp/emsdk-hello.o

RUN printf 'export PATH="/emsdk:/emsdk/upstream/emscripten:$PATH"\nexport EM_CONFIG="/emsdk/.emscripten"\nexport EM_CACHE="/emsdk/upstream/emscripten/cache"\n' \
        > /etc/profile.d/emsdk.sh \
    && cat /etc/profile.d/emsdk.sh >> /etc/bash.bashrc

# Provides sha3sum plus Tcl, which SQLite needs to generate a custom
# amalgamation from its canonical source tree.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libdigest-sha3-perl tcl \
    && rm -rf /var/lib/apt/lists/*
