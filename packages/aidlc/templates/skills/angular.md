---
name: aidlc-angular
description: Angular component, dependency injection, RxJS, forms, routing, and testing standards for an AIDLC repository.
---

# Angular

Follow the component style already used in the project. Do not convert NgModules to standalone components, or the reverse, unless the plan says so.

## Components and dependency injection

- Keep components thin. Put business decisions in services that can be tested without the DOM.
- Inject collaborators through the constructor or the project's existing `inject()` style. Do not construct services with `new` inside a component.
- Provide a service at the narrowest injector that still matches its lifetime.
- Do not reach into another feature's private classes.

## RxJS

- Unsubscribe work that outlives a single emission. Prefer `takeUntilDestroyed`, the async pipe, or the project's existing subscription helper.
- Do not nest subscriptions. Compose with operators.
- Keep HTTP calls in services and surface errors to the caller. Do not swallow an error and return an empty success.

## Forms, routing, and guards

- Use the form approach already in the feature, reactive or template-driven.
- Validate at the form boundary and again on the server. Client checks are not an authorization control.
- Guard privileged routes with the existing guard pattern. A hidden button is not authorization.
- Keep route parameters validated before they reach a service call.

## Change detection and tests

- Do not call `detectChanges` in production code to paper over a data-flow bug.
- Use the project's TestBed or the existing standalone test setup.
- Test a component through its template and inputs. Test a service by replacing its HTTP or repository dependency.
- Cover a failed request and an invalid form, not only the happy path.
