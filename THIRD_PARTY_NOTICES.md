# Third-party notices

## Noto Sans Hebrew

SupplyFlow includes local Hebrew and Latin WOFF2 subsets of Noto Sans Hebrew, version 50 from
Google Fonts. Noto Sans Hebrew is licensed under the SIL Open Font License 1.1. The full license is
stored at `public/fonts/noto/OFL.txt`.

Source: https://fonts.google.com/noto/specimen/Noto+Sans+Hebrew

## Almoni Neue

Almoni Neue is not included in this repository. Production builds may use customer-supplied,
unmodified WOFF2 files only under a valid commercial webfont license that covers the deployed SaaS
domains and traffic. `scripts/build-almoni.mjs` verifies approved SHA-256 hashes, stages the files for
one build, and removes the staging directory afterward. Font files must not be committed, published
as source artifacts, subsetted, converted, or otherwise modified by this project.
