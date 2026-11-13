# The e2e suite as an image: @wshno/playwright-config's runner image (node slim + chromium-headless-
# shell for the pinned @playwright/test) with e2e/'s npm packages and specs baked in. Run as the
# `playwright` service of docker-compose.e2e.yml (profile e2e), next to the image it tests: the same
# compose file locally and in CI.
#
# PLAYWRIGHT_CONFIG_VERSION must equal @wshno/playwright-config in package-lock.json, so the image's
# browser matches the suite's Playwright; pr-e2e.yml reads it from the lock file.

ARG PLAYWRIGHT_CONFIG_VERSION=0.6.0
FROM ghcr.io/wshno/playwright-config:${PLAYWRIGHT_CONFIG_VERSION}

WORKDIR /e2e

# Manifests first: a change to the specs alone keeps the npm ci layer cached.
COPY package.json package-lock.json ./
RUN npm ci && rm -rf /root/.npm

COPY . .

# playwright.ci.config.ts: against the already-running combined image (no webServer).
CMD ["npm", "run", "test:ci"]
