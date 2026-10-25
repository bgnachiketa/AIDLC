---
name: aidlc-react
description: React composition, state, hooks, accessibility, performance, and testing standards for an AIDLC repository.
---

# React

Use these rules for React UI. Match the components, state library, and test renderer already in the repository.

## Composition and state

- Prefer composition. Do not introduce a new state library when the project already has one, or when local state is enough.
- Keep state as close as possible to the components that use it.
- Derive values during render instead of copying them into state.
- Do not store server data in local state when the project already has a data-fetching cache.

## Hooks

- Call hooks unconditionally at the top level of a component or custom hook.
- Include every reactive value used by an effect in its dependency list.
- Return a cleanup function for subscriptions, timers, sockets, and observers.
- Do not disable exhaustive dependency checks to hide a stale closure.
- Name reusable hook logic `useX` and keep each hook focused on one behavior.

## Rendering

- Do not define a component inside another component.
- Give lists stable keys. Do not use the array index when items can be reordered, filtered, or inserted.
- Memoize only after identifying a real render cost. Do not wrap every callback in `useCallback` by default.
- Keep render functions free of network requests and other side effects.

## Accessibility

- Use a native element before adding ARIA.
- Give every interactive control an accessible name.
- Provide text alternatives for informative images and an empty alternative for decorative images.
- Keep keyboard operation and a visible focus indicator.
- Restore focus when a dialog closes, and do not trap focus outside a genuine modal.

## Tests

- Test what a person can see or operate, not private state.
- Cover the success path, a validation or error path, and an empty or loading path when the UI has one.
- Query by role or accessible name using the project's existing test utilities.
