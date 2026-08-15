FROM node:20-alpine
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
