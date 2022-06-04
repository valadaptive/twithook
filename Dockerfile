# syntax=docker/dockerfile:1

FROM node:18-alpine
COPY ./package.json ./
COPY ./package-lock.json ./
RUN npm ci
COPY . .

CMD [ "npm", "start" ]
