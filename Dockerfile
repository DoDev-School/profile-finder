FROM node:18-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./

# Se existir package-lock.json, roda ci; se não, roda install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

COPY . .

CMD ["npm", "start"]
