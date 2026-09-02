# Vendored: h5wasm

- **Version:** 0.10.3
- **Source:** npm package `h5wasm` (`https://registry.npmjs.org/h5wasm/-/h5wasm-0.10.3.tgz`), files `dist/esm/hdf5_hl.js` and `dist/esm/hdf5_util.js`, unmodified.
- **Upstream:** https://github.com/usnistgov/h5wasm
- **License:** see `LICENSE.txt` (NIST public-domain-style statement).

## Why vendored

GitHub Pages serves only static files and we want zero build step / zero CDN
dependency. These two ES modules are the entire runtime:

- `hdf5_hl.js` — high-level API (`File`, `Group`, `Dataset`, `ready`).
- `hdf5_util.js` — Emscripten module with the HDF5 WASM binary **embedded**
  (base64 inside the JS via `binaryDecode(...)`), so there is no separate
  `.wasm` file to host and no `.wasm` MIME / CORS / COOP-COEP concern.

The build links `WORKERFS` (`filesystems={MEMFS,IDBFS,WORKERFS}`), which lets a
Web Worker mount a user-selected `File` and read it in slices via
`FileReaderSync` — no full in-memory copy. That is how large `.h5ad` files are
supported.

## Updating

Download a newer tarball, replace the two `.js` files, bump the version above,
and re-run `scripts/smoke_h5wasm.mjs` (if present) against a known `.h5ad`.
