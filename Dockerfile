FROM node:18-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
