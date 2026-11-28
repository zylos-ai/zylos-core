#!/bin/sh
set -eu

plugins_disabled=false
while [ "$#" -ge 2 ] && [ "$1" = --disable ]; do
  if [ "$2" = plugins ]; then
    plugins_disabled=true
  fi
  shift 2
done
[ "$plugins_disabled" = true ] || exit 2
[ "$#" -eq 3 ] && [ "$1" = mcp ] && [ "$2" = list ] && [ "$3" = --json ] || exit 2
printf '%s\n' "$TEST_CODEX_MCP_LIST"
