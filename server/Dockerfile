FROM denoland/deno:alpine-2.0.3
WORKDIR /app
COPY . .
RUN deno cache --lock --check main.ts
CMD ["deno", "task", "run"]
