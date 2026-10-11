# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@12.4.1
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY . .
ENV VITE_API_BASE="" VITE_USE_MOCKS=false
RUN pnpm build

FROM nginx:stable-alpine-slim AS runtime
RUN addgroup -g 10001 app \
 && adduser -D -H -u 10001 -G app app \
 && rm /etc/nginx/conf.d/default.conf \
 && chown app:app /etc/nginx/conf.d
COPY <<'EOF' /etc/nginx/nginx.conf
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {
    worker_connections 1024;
}
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log /dev/stdout;
    sendfile on;
    client_body_temp_path /tmp/client_temp;
    proxy_temp_path /tmp/proxy_temp;
    fastcgi_temp_path /tmp/fastcgi_temp;
    uwsgi_temp_path /tmp/uwsgi_temp;
    scgi_temp_path /tmp/scgi_temp;
    include /etc/nginx/conf.d/*.conf;
}
EOF
COPY <<'EOF' /etc/nginx/templates/default.conf.template
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;

    location ~ ^/(api(?:/|$)|readyz$|metrics$) {
        proxy_pass ${API_TARGET};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /healthz {
        access_log off;
        return 200 "ok\n";
    }

    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}
EOF
COPY --from=build /app/dist /usr/share/nginx/html
ENV API_TARGET=http://homeautomator:80 \
    NGINX_ENVSUBST_FILTER=API_TARGET
USER 10001:10001
EXPOSE 8080
