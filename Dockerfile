FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git curl bash openssh-client

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

CMD ["npm", "start"]
