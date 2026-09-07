#!/bin/bash

set -euo pipefail

cd "${GITHUB_WORKSPACE:-/github/workspace}"
bun install --frozen-lockfile
bun run build
bun test
