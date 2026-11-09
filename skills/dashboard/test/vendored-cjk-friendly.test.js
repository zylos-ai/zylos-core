import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Compare shipped bytes with the pinned development packages; no package code,
// services, databases or network are executed by this provenance check.
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url)));
const vendorRoot = new URL('../public/js/markdown-it-cjk-friendly/', import.meta.url);
const packages = [
  { name: 'markdown-it-cjk-friendly', root: new URL('../', import.meta.resolve('markdown-it-cjk-friendly')),
    target: vendorRoot, files: [['dist/index.js', 'index.js']], license: 'LICENSE' },
  { name: 'get-east-asian-width', root: new URL('./', import.meta.resolve('get-east-asian-width')),
    target: new URL('get-east-asian-width/', vendorRoot),
    files: ['index.js', 'lookup.js', 'lookup-data.js', 'utilities.js'].map(file => [file, file]), license: 'license' },
];

for (const pkg of packages) {
  test(`vendored ${pkg.name} matches its pinned npm source and MIT license`, () => {
    const version = manifest.devDependencies[pkg.name];
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[`node_modules/${pkg.name}`].version, version);
    const installed = JSON.parse(fs.readFileSync(new URL('package.json', pkg.root)));
    assert.equal(installed.version, version);
    assert.equal(installed.license, 'MIT');
    for (const [source, target] of pkg.files) {
      let original = fs.readFileSync(new URL(source, pkg.root));
      if (pkg.name === 'markdown-it-cjk-friendly') {
        const text = original.toString('utf8');
        assert.equal(text.split('from "get-east-asian-width"').length - 1, 1);
        original = Buffer.from(text.replace('from "get-east-asian-width"', 'from "./get-east-asian-width/index.js"'));
      }
      // The required source/version banner is checked separately from the
      // upstream bytes; the sole runtime edit is the bare-import rewrite above.
      const banner = Buffer.from(`// Vendored from ${pkg.name}@${version}; MIT license in ${pkg.license}.\n`);
      const shipped = fs.readFileSync(new URL(target, pkg.target));
      assert.ok(shipped.equals(Buffer.concat([banner, original])), `${pkg.name}/${target} differs from pinned source`);
    }
    const license = fs.readFileSync(new URL(pkg.license, pkg.root));
    assert.ok(fs.readFileSync(new URL(pkg.license, pkg.target)).equals(license), `${pkg.name} license differs`);
  });
}
