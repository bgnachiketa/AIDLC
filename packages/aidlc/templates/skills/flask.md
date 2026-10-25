---
name: aidlc-flask
description: Flask application factory, blueprint, validation, error handler, and test standards for an AIDLC repository.
---

# Flask

- Use the application factory when the project already has one. Do not create a second global app object.
- Put routes on a blueprint and register it in the factory.
- Validate form and JSON input before use. Do not trust `request.json` or `request.args` unchecked.
- Register error handlers that return the project's error shape and do not leak tracebacks to clients.
- Read configuration from the existing config objects and environment. Do not hardcode secrets.
- Use the Flask test client and an application context in tests. Clean up any database or temporary file the test creates.
- Cover an invalid request and an error handler path for the change, not only a successful response.
