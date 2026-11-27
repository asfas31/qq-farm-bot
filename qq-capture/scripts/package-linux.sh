#!/usr/bin/env bash
set -euo pipefail
VERSION="${1:?usage: package-linux.sh <version> <output-root>}"
OUTPUT_ROOT="${2:?usage: package-linux.sh <version> <output-root>}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PACKAGE_NAME="qq-capture-linux-amd64-${VERSION}"
STAGE="${OUTPUT_ROOT}/${PACKAGE_NAME}"
ARCHIVE="${OUTPUT_ROOT}/${PACKAGE_NAME}.tar.gz"

rm -rf "$STAGE" "$ARCHIVE"
mkdir -p "$STAGE/deploy/systemd"
cd "$PROJECT_ROOT"
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$STAGE/qq-capture" .
cp config.example.yaml .env.example README-DEPLOY.md "$STAGE/"
cp deploy/systemd/qq-capture.service "$STAGE/deploy/systemd/"
cp deploy/docker-compose.yml "$STAGE/deploy/"
cp deploy/Dockerfile.release "$STAGE/Dockerfile.release"
tar -C "$OUTPUT_ROOT" -czf "$ARCHIVE" "$PACKAGE_NAME"
rm -rf "$STAGE"
printf '%s\n' "$ARCHIVE"
