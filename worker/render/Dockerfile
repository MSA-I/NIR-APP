# The render service. Deployed beside the OCR worker on the same VPS; it is NOT deployed by any
# quality gate, any merge to `main`, or any Pages rollout — exactly like `worker/ocr`, and for the
# same reason that is written down in CLAUDE.md: nothing in this repository can reach that machine.
#
# The base image is Microsoft's Playwright image and the tag MUST match `playwright-core` in
# package.json. That is not a preference: `playwright-core` resolves the browser it was built
# against out of `PLAYWRIGHT_BROWSERS_PATH`, and a mismatched pair fails at launch — loudly, on the
# first render, which is the failure mode we want rather than a silent one.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY assets ./assets
COPY self_check.mjs ./

# Runs as the image's non-root `pwuser`. The service holds a live user session for the seconds a
# render takes, so it gets no more of the machine than it needs.
USER pwuser

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
