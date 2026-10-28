FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY tracker.js ./
COPY docs/config.json ./docs/config.json
ENV TZ=America/Chicago
CMD ["node", "tracker.js"]
