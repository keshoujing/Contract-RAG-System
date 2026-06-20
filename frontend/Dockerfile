# Frontend image: build the React/Vite app, serve the static bundle with nginx.
# nginx also proxies /api -> backend (same-origin, so no CORS config needed).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . ./
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
