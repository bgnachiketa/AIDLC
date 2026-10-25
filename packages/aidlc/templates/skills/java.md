---
name: aidlc-java
description: Java type safety, error handling, resource cleanup, and test standards for an AIDLC repository.
---

# Java

- Follow the existing package layout, formatter, and build tool. Do not mix Maven and Gradle in the same module.
- Keep nullability explicit. Do not silence a null warning with an unchecked cast.
- Close resources with try-with-resources.
- Do not catch `Exception` only to log and continue unless that is the established boundary policy.
- Validate input at the edge of the module and keep domain types free of transport annotations when the project already separates them.
- Prefer the existing logging facade. Do not log secrets or personal data.
- Add a focused unit test for the changed behavior and use the project's integration test style when a boundary changed.
- Do not upgrade the Java language level or the whole dependency set as part of an unrelated change.
