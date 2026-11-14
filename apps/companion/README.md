# Phone panel

The owner's Angular panel of AI Copilot (assistant with push-to-talk, car readings and alerts, settings); in Docker it is served by nginx (`nginx.conf`), which also passes `/api` and `/car/v1` to the backend.
`npm start` serves it on http://localhost:4200 with `/api` and `/car/v1` proxied to a backend on port 3000; `npm test` runs the specs headless (Vitest with jsdom); `npm run build` writes the production build to `dist/companion`.
Setup, configuration, pairing and deployment are described in the repository's root `README.md`.
