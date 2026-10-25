---
name: aidlc-spring-boot
description: Spring Boot layering, validation, transactions, security, JPA, and test-slice standards for an AIDLC repository.
---

# Spring Boot

## Boundaries

- Controllers translate HTTP. Services own the use case. Repositories own persistence. Do not put repository calls and business decisions in the controller.
- Use constructor injection. Do not use field injection in new code.
- Map entities to DTOs at the boundary when the project already does. Do not return a persistence entity just to save a class.
- Validate DTOs with the project's Bean Validation setup. Enforce authorization in the service or security layer, not only in the controller.

## Transactions and persistence

- Put the transaction boundary on the service method that defines the use case.
- Do not hold a transaction open across a remote call.
- Watch lazy-loading and N+1 queries. Fetch the association the use case needs or map a projection.
- Add a migration through the tool already configured, such as Flyway or Liquibase. Make it reviewable and reversible when that is feasible.
- Do not run a destructive migration as part of a test shortcut.

## Security and tests

- Use the existing Spring Security filter chain and method security. Do not permit all traffic to make a test pass.
- Use a slice test for a controller or repository when that is enough, and a fuller Spring test only when the change crosses slices.
- Cover invalid input, an unauthorized caller, and the persistence behavior that changed.
