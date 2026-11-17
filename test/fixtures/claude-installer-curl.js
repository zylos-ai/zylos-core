#!/usr/bin/env node
// Network-free stand-in for curl; the product still runs its native shell pipeline.
if (process.argv.slice(2).join(' ') !== '-fsSL https://claude.ai/install.sh') process.exit(2);
if (process.env.TEST_CURL_FAIL === '1') {
  console.error('isolated download failed');
  process.exit(22);
}
process.stdout.write('exec "$TEST_INSTALL_NODE" "$TEST_INSTALL_FIXTURE"\n');
