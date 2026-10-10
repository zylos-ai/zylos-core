#!/bin/sh
# Maintainer-only. End users receive the checked-in universal executable.
set -eu
cd "$(dirname "$0")/.."
export ZERO_AR_DATE=1
xcrun clang -std=c11 -O2 -Wall -Wextra -Werror -arch arm64 -arch x86_64 \
  -mmacosx-version-min=11.0 \
  cli/native/macos-recovery-helper.c -o cli/native/macos-recovery-helper
chmod 755 cli/native/macos-recovery-helper
shasum -a 256 cli/native/macos-recovery-helper | cut -d " " -f 1 > cli/native/macos-recovery-helper.sha256
shasum -a 256 cli/native/macos-recovery-helper.c cli/native/macos-recovery-helper
