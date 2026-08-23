/**
 * Reading the request from inside a view.
 *
 * Rails views reach the request implicitly, which is convenient and untypeable.
 * Threading it through every component instead is typeable and miserable: a
 * CSRF token would have to pass through every layout and partial between the
 * page and the form that needs it.
 *
 * The middle is an ambient, request-scoped store, which is what `Current`
 * already is — the same mechanism the ORM scopes a transaction with, and the
 * same one Next.js's `headers()` and `cookies()` use. It survives the async
 * component walk and two renders side by side cannot see each other's.
 *
 * The rule this draws: **page data goes in props, the request goes in scope.**
 * Anything a component genuinely takes as input should be an argument. What
 * belongs here is the handful of things that are true of the whole request.
 */

import { Current } from "@altair/support";

/** The request being served, or undefined outside one. */
export function useRequest(): Request | undefined {
  return Current.request;
}

/** The request's URL, already parsed. */
export function useUrl(): URL | undefined {
  const request = Current.request;
  return request ? new URL(request.url) : undefined;
}

/** The path being served, which is what a nav component highlights against. */
export function usePath(): string | undefined {
  return useUrl()?.pathname;
}

/** Correlates a rendered page with the log lines from the same request. */
export function useRequestId(): string | undefined {
  return Current.requestId;
}

/**
 * Whoever is signed in.
 *
 * Typed by the application, which widens `CurrentState` by declaration
 * merging rather than casting at every call site.
 */
export function useCurrentUser<T = unknown>(): T | undefined {
  return Current.user as T | undefined;
}

/**
 * The token a form has to echo back. Rails' `form_authenticity_token`.
 *
 * The controller puts it here when it dispatches, so a form deep in a partial
 * can reach it without being handed it.
 */
export function useCsrfToken(): string | undefined {
  return Current.csrfToken;
}

/**
 * The nonce this response's Content Security Policy allows.
 *
 * An inline script or style has to carry it to run at all, which is the point:
 * one script the page vouched for, rather than every inline script.
 */
export function useCspNonce(): string | undefined {
  return Current.cspNonce;
}

/** Messages that survived one redirect. Rails' `flash`. */
export function useFlash(): Readonly<Record<string, unknown>> {
  return Current.flash ?? {};
}

/** One flash message, as a string. */
export function useFlashMessage(key: string): string | undefined {
  const value = useFlash()[key];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Whether a request is in scope at all.
 *
 * A component rendered from a script or a test has no request, and reading one
 * is undefined rather than a throw — so this is how a component that can work
 * either way asks.
 */
export function hasRequest(): boolean {
  return Current.isActive && Current.request !== undefined;
}
