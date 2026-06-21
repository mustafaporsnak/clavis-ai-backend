FROM node:22-bookworm

WORKDIR /app

COPY package*.json ./

RUN npm install

ENV PLAYWRIGHT_BROWSERS_PATH=0

RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["npm", "start"]
