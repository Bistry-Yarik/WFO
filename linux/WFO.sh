#!/bin/sh
set -eu

directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
game="$directory/index.html"
if command -v xdg-open >/dev/null 2>&1; then
    exec xdg-open "$game"
fi
if command -v gio >/dev/null 2>&1; then
    exec gio open "$game"
fi
printf 'Откройте этот файл в браузере: %s\n' "$game" >&2
exit 1
