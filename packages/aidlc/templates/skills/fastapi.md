---
name: aidlc-fastapi
description: FastAPI models, dependencies, async handlers, auth, OpenAPI, and API test standards for an AIDLC repository.
---

# FastAPI

- Define request and response bodies with Pydantic models. Do not accept an untyped `dict` for a new public payload.
- Put request-scoped collaborators in dependencies. Override them in tests instead of reaching into globals.
- Do not run blocking I/O directly in an `async def` path. Use a normal `def` endpoint or move the work off the event loop with the project's existing pattern.
- Authenticate and authorize in dependencies. A dependency that only parses a token is not authorization.
- Keep the OpenAPI contract accurate. When a response shape changes, update the response model and the tests that assert it.
- Add tests for a valid call, a validation error, and an unauthorized call when the route is protected.
- Use dependency overrides and the test client. Do not require a live external account.
