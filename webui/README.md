# home-webui

> [!WARNING]
> Personal home automation project. Made for a specific house; it will not work for others.

Web UI for [`home-automator`](../automator).

Vite 8, React 19, TypeScript, Material Web, React Router 7, TanStack Query 5, Zod, Biome, Vitest.

## Run

```sh
pnpm install
pnpm dev
```

By default, Vite proxies `/api-proxy` to `http://localhost:8099`. Set `VITE_API_TARGET` to change
the backend. Run without a backend using fixtures:

```sh
VITE_USE_MOCKS=true pnpm dev
```

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Deploy

`pnpm build` creates `dist/`. The container setup is in [`infra/docker/webui`](../infra/docker/webui).
