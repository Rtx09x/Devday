# Clean Cutu Circuits release

The release retains Cutu Circuits branding, native engineering sources, the application's version-history and recovery features, all 40 Makada STL meshes, firmware, examples, tests and dependency/source provenance. It starts a separate Git repository with one initial commit and no remote.

## Generate the upload

Use Node 24 and Git. From the working repository, install with `npm ci`, run `npm run build`, then:

```sh
node scripts/package-release.mjs
```

Generated files are under `artifacts/release/`:

- `cutu-circuits/`: the clean repository, on `main`, ready to upload.
- `clean-source.zip`: the same source files, without Git metadata.
- `manifest.json`: every included file's size and SHA-256, plus the archive checksum and initial commit.
- `SHA256SUMS`: the archive checksum, suitable for `sha256sum -c SHA256SUMS`.

The explicit allowlist in the packaging script includes current product packages, examples, installation metadata, documentation and required notices. The standalone plugin bundle and its full dependency licenses are included, so a copied plugin can start with Node 24. The web application is built after extraction. Local projects, private version/recovery records, credentials, original reference checkouts, research, audits, earlier verification reports, screenshots, conversation instructions, caches and dependencies are excluded. App version-history code remains part of the product.

Packaging never changes the working repository's Git metadata, local projects or reference sources. Regeneration replaces only `artifacts/release/cutu-circuits` and the generated archive/manifest/checksum; use the working repository to regenerate if you have already started using the exported repository. The exported model reference contains current assumptions and citations; internal work assignments and historical validation are omitted. The ZIP uses sorted entries, fixed permissions and a fixed default timestamp of 2026-10-31 UTC. Identical inputs and the same Node/zlib version produce identical archives. The initial Git commit uses the actual current UTC time. For explicitly reproducible timestamps including the commit, set `SOURCE_DATE_EPOCH`.

## Verify a fresh copy

Extract the ZIP into a new directory, enter `cutu-circuits`, then run:

```sh
npm ci
npm run typecheck
npm run build
```

Run `npm start` and open `http://127.0.0.1:4310`. See [the demo guide](demo.md) for the walkthrough and [plugin setup](../plugins/cutucircuits/README.md) for Codex installation. This release ships code and example assets; it contains no existing local project or private project history.

## Upload to your empty GitHub repository

Create an empty GitHub repository, then run these three commands, substituting your repository URL:

```sh
cd artifacts/release/cutu-circuits
git remote add origin https://github.com/YOUR_ACCOUNT/cutu-circuits.git
git push -u origin main
```

These commands upload the separate clean repository and its single initial commit. No remote is configured and nothing is pushed by the packaging script. Required upstream license texts and pinned source revisions remain in the release as attribution and dependency provenance.
