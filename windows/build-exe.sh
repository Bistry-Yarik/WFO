#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
target="$(realpath -m "${1:-./WFO.exe}")"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT

python3 build-standalone.py
cp windows/main.go windows/server.go windows/inference.go windows/go.mod windows/go.sum index.html "$build/"
go-winres simply --arch amd64 --manifest gui --product-name WFO \
    --file-description WFO --original-filename WFO.exe \
    --icon android/res/drawable-nodpi/wfo_icon.png --out "$build/rsrc"
cd "$build"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -buildvcs=false -mod=readonly \
    -trimpath -ldflags='-s -w -H windowsgui' -o "$target" .
