import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// SHA-512 pins cover unmodified files from the official npm tarballs:
// markdown-it-cjk-friendly/-/markdown-it-cjk-friendly-3.0.0.tgz and
// get-east-asian-width/-/get-east-asian-width-1.7.0.tgz on registry.npmjs.org.
// Updating the vendor requires reviewing new upstream bytes and updating these
// pins. This check needs no node_modules, package execution, services or network.
const vendorRoot = new URL('../public/js/markdown-it-cjk-friendly/', import.meta.url);
const packages = [
  { name: 'markdown-it-cjk-friendly', version: '3.0.0', target: vendorRoot, license: 'LICENSE',
    files: [
      ['index.js', 'd7e3c1327a9a4f0da519bf12bde665da1a40603adff7ba58deb7629bfb0fab1c1cbf6ee2faa687b2aff9afb249edff6b760ce71d1f97ee7ad3bbaf9866dc4574'],
    ],
    licenseHash: '71452447f6abf4c5f604c187bbc5f08370d2f21ffce1bdb4e5de2bcc082928293bf926d8f906d5593b6234b03573a0de42e907431223a0d30c154c5d0efd029f' },
  { name: 'get-east-asian-width', version: '1.7.0', target: new URL('get-east-asian-width/', vendorRoot), license: 'license',
    files: [
      ['index.js', '2ce0c477bda2677c35bf66830d22290472ddeeda6b160487ad1bcba25e5cc716b9b29c992697b27dbe053b070dc63f6a8029c2a24dbb7187d21f86cbf2edc348'],
      ['lookup.js', '13ab4d685475a29b54ae33533e36771f623ba44197cc64c5e63060c8b8c9f5c17efda355ecb7e857de85b62350233543057366b11780f07ad414001bf2713387'],
      ['lookup-data.js', '60809af19a0048ba837d8168070c65d9b645354f1826f73eac5c69247f6ad8bd1736e1a93d6368b7a7f814b2f6cfdf1fec0c6a7a8329593e4a9174a3639f62d2'],
      ['utilities.js', '9805872eb054f1531444ff0b68a94b93d593582824adefe57061a7b85d24c671cc3aa4ef13320a2979ae41c8f410a8f5a9bd71de0438baf1f3afbcba8ea414da'],
    ],
    licenseHash: 'd1f336ff272bc6b96dc9a04a7d0ef8f02936dd594f514060340478ee575fe01d55fc7a174df5814a4faf72c8462b012998eca7bb898e3f9a3e87205fb9135af2' },
];
const sha512 = bytes => createHash('sha512').update(bytes).digest('hex');

for (const pkg of packages) {
  test(`vendored ${pkg.name} matches pinned upstream source and MIT license hashes`, () => {
    const banner = Buffer.from(`// Vendored from ${pkg.name}@${pkg.version}; MIT license in ${pkg.license}.\n`);
    for (const [file, hash] of pkg.files) {
      const shipped = fs.readFileSync(new URL(file, pkg.target));
      assert.ok(shipped.subarray(0, banner.length).equals(banner), `${pkg.name}/${file} source banner differs`);
      let original = shipped.subarray(banner.length);
      if (pkg.name === 'markdown-it-cjk-friendly') {
        const relativeImport = Buffer.from('from "./get-east-asian-width/index.js"');
        const position = original.indexOf(relativeImport);
        assert.ok(position >= 0, 'the vendored plugin must use its local dependency');
        assert.equal(original.indexOf(relativeImport, position + relativeImport.length), -1, 'expected exactly one rewritten import');
        original = Buffer.concat([original.subarray(0, position), Buffer.from('from "get-east-asian-width"'), original.subarray(position + relativeImport.length)]);
      }
      assert.equal(sha512(original), hash, `${pkg.name}/${file} differs from pinned upstream source`);
    }
    assert.equal(sha512(fs.readFileSync(new URL(pkg.license, pkg.target))), pkg.licenseHash, `${pkg.name} MIT license differs`);
  });
}
