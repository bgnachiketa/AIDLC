---
name: aidlc-nextjs
description: Next.js routing, server and client boundaries, data access, caching, and secret-handling standards for an AIDLC repository.
---

# Next.js

Detect the router before editing. App Router code lives under `app`. Pages Router code lives under `pages`. If both exist, follow the router used by the route you are changing.

## Server and client boundaries

- Keep components as Server Components unless they need state, effects, or browser APIs.
- Add `"use client"` only on the smallest client subtree.
- Do not import a server-only module into a client component.
- Do not pass functions or class instances across the server/client boundary.

## Data access

- Read data in the server component, route handler, or existing data layer. Do not query the database from a client component.
- Validate route-handler input. Do not trust search params, headers, or JSON bodies.
- Keep secrets in server code and environment variables. Never prefix a secret with `NEXT_PUBLIC_`.
- Use the project's existing authentication helper. Do not invent a second session mechanism.

## Caching and rendering

- Do not disable caching globally to fix one stale screen. Choose the narrowest revalidation or dynamic option the framework version in this repo supports.
- Redirect and not-found behavior should use the project's existing helpers.
- Metadata and status codes belong in the server response, not only in client state.

## Tests

- Add a test for each changed route or component using the repository's current runner.
- Cover an unauthorized request and an invalid payload for changed route handlers.
- Assert the production build still typechecks when the plan's quality gates require it.
