---
name: aidlc-python
description: Python environment, typing, exception, logging, and test-isolation standards for an AIDLC repository.
---

# Python

- Use the virtual environment and dependency file the repository already uses. Do not add a second lockfile or environment tool.
- Add type hints on new public functions. Do not silence the type checker with a blanket ignore.
- Raise a specific exception. Do not use a bare `except:` and do not catch `Exception` unless you are at a process boundary that logs and translates it.
- Close files, sockets, and database connections with a context manager.
- Log through the project's logging configuration. Do not log secrets or personal data, and do not use `print` for operational errors.
- Keep tests isolated. Do not depend on test order, the developer's home directory, or a real external service.
- Use the configured formatter and linter. Do not reformat unrelated modules.
