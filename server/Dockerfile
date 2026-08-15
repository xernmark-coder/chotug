FROM node:20-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install
COPY server/ ./
COPY db/ /app/db/
EXPOSE 4000
CMD ["npm", "run", "dev"]
