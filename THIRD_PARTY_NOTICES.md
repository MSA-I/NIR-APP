# Third-party notices

## Noto Sans Hebrew

InPlace includes local Hebrew and Latin WOFF2 subsets of Noto Sans Hebrew, version 50 from
Google Fonts. Noto Sans Hebrew is licensed under the SIL Open Font License 1.1. The full license is
stored at `public/fonts/noto/OFL.txt`.

Source: https://fonts.google.com/noto/specimen/Noto+Sans+Hebrew

## Heebo

InPlace includes local Hebrew and Latin WOFF2 subsets of Heebo, used as the display face inside
generated documents (`--font-doc-display`, DESIGN.md 5.5). Heebo is licensed under the SIL Open
Font License 1.1. The files are byte-identical to the ones the InPlace marketing site serves, and
the full license is stored at `public/fonts/FONT-LICENSES.txt`.

Source: https://fonts.google.com/specimen/Heebo

## Roboto Mono

InPlace includes a local Latin WOFF2 subset of Roboto Mono, used for document numbers, references
and the eyebrow line inside generated documents (`--font-doc-mono`). It carries no Hebrew glyphs,
which is why the `unicode-range` in `src/index.css` is stated explicitly. Licensed under the SIL
Open Font License 1.1; the full license is stored at `public/fonts/FONT-LICENSES.txt`.

Source: https://fonts.google.com/specimen/Roboto+Mono

## Almoni Neue

Almoni Neue is not included in this repository. Production builds may use customer-supplied,
unmodified WOFF2 files only under a valid commercial webfont license that covers the deployed SaaS
domains and traffic. `scripts/build-almoni.mjs` verifies approved SHA-256 hashes, stages the files for
one build, and removes the staging directory afterward. Font files must not be committed, published
as source artifacts, subsetted, converted, or otherwise modified by this project.
