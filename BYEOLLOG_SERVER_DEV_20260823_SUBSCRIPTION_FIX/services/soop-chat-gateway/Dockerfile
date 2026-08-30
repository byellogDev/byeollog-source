FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY lib ./lib
COPY services/soop-chat-gateway ./services/soop-chat-gateway

RUN useradd --create-home --uid 10001 byeollog \
  && mkdir -p /var/lib/byeollog \
  && chown -R byeollog:byeollog /app /var/lib/byeollog

USER byeollog
ENV NODE_ENV=production \
    HOME=/tmp \
    SOOP_GATEWAY_BROWSER=/usr/bin/chromium \
    SOOP_GATEWAY_CHROME_NO_SANDBOX=true \
    SOOP_GATEWAY_STATE_DIR=/var/lib/byeollog \
    SOOP_GATEWAY_HEALTH_HOST=0.0.0.0 \
    SOOP_GATEWAY_HEALTH_PORT=8080
EXPOSE 8080
VOLUME ["/var/lib/byeollog"]
HEALTHCHECK --interval=20s --timeout=3s --start-period=20s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node","services/soop-chat-gateway/supervisor.mjs"]
