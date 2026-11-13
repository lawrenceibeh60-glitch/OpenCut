# KYROCUT X1 creative assets and licenses

## Bundled LUT starter pack

The web app includes 15 downloadable 3D LUT files sourced from:

- Repository: https://github.com/YahiaAngelo/Film-Luts
- License: MIT
- License copy: `apps/web/public/assets/luts/LICENSE-MIT.txt`
- Bundled catalog: `apps/web/public/assets/luts/catalog.json`
- Individual starter LUT files: `apps/web/public/assets/luts/*.cube`

The MIT license is included with the assets. The source catalog names are retained for provenance. These files are currently exposed as downloads; they are **not yet wired into live preview or final rendering**.

## Other curated sources

- DAEDAL film assets and LUTs: https://daedal.art/ — the provider states its LUTs, film assets and sound effects are CC0 1.0. Check the exact pack and its included license before importing.
- Google Fonts: https://fonts.google.com/ — families have their own license metadata; check each family before redistribution. KYROCUT loads selected families on demand from Google Fonts rather than bundling all font binaries.
- ambientCG: https://ambientcg.com/ — CC0 assets.
- Poly Haven: https://polyhaven.com/ — CC0 assets.

These external sources are listed for user-initiated downloads/imports. Their full libraries are not mirrored in this repository.

## Model dependency

Background removal uses `@bg0/browser` (Apache-2.0). Its model weights have separate third-party notices and are downloaded by the library when the feature is first used. Image processing runs in the browser; the selected image is not uploaded to KYROCUT.

## Rights and attribution

A free download does not automatically mean an asset can be repackaged. Preserve each included license and attribution record. Do not package assets whose terms prohibit redistribution.
