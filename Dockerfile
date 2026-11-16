FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["npm","start"]
