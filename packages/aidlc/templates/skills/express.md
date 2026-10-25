---
name: aidlc-express
description: Express middleware order, error handling, validation, authorization, and API test standards for an AIDLC repository.
---

# Express

## Middleware

- Keep the existing order. In particular, body parsing, authentication, and the error handler must stay in the order the application already relies on.
- Register the error-handling middleware last, with four parameters.
- Do not send a response and also call `next()` with an error.
- Mount routers on a path prefix instead of copying route tables.

## Validation and authorization

- Validate params, query, and body before they reach domain code. Use the validator the project already uses.
- Authenticate first, then authorize the specific action. A valid session is not permission to perform every operation.
- Apply rate limiting only through the existing mechanism unless the plan adds one deliberately.
- Encode output for its context. Parameterize any database query.

## Errors and tests

- Send one error JSON shape. Do not leak stack traces or SQL to the client.
- Add API tests for the changed route: success, invalid input, and forbidden or unauthenticated access when the route is protected.
- Close the server and any test database handle in the test teardown.
