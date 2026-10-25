---
name: aidlc-django
description: Django app, ORM, migration, permission, CSRF, and test standards for an AIDLC repository.
---

# Django

- Keep the change inside the relevant app. Do not import models across apps in a way that creates a cycle.
- Use the ORM and parameterized queries. Do not build SQL by concatenating request data.
- Add a migration for model changes with the project's Django version. Review the generated operations. Do not squash or delete migrations that are already shared unless the plan says so.
- Enforce authentication and permissions on the view or the existing DRF permission class. A missing button is not a permission check.
- Leave CSRF middleware and security middleware enabled. Do not mark a state-changing view exempt unless the plan documents the reason.
- Select related rows deliberately. Do not hide an N+1 query behind a template loop.
- Use the Django test client or the existing API client, and keep tests inside transactions so they roll back.
- Cover an anonymous or unauthorized request and a validation failure for the changed view.
