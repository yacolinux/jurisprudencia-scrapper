FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    JURIS_ACCESS_MODE=auto \
    JURIS_HEADLESS=0 \
    JURIS_USE_XVFB=1 \
    OPENCODE_ENABLED=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium chromium-sandbox xvfb poppler-utils ca-certificates fonts-liberation \
  && npm install --global opencode-ai \
  && useradd --create-home --shell /bin/bash app \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY opencode.json ./opencode.json
RUN chown -R app:app /app

USER app

EXPOSE 3000
CMD ["node", "src/web-server.mjs"]
