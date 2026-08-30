/**
 * Status codes by name, ported from Rack's `SYMBOL_TO_STATUS_CODE` table and
 * the `status:` cases in `actionpack/test/controller/render_test.rb`.
 */

import { describe, expect, it } from "bun:test";
import {
  STATUS_CODES,
  allowsBody,
  codeAndName,
  isClientError,
  isInformational,
  isRedirection,
  isServerError,
  isSuccessful,
  statusCode,
  statusMessage,
  statusNames,
  statusRegistered,
} from "../src/http_status.js";

describe("statusCode", () => {
  it("gives the number for a name", () => {
    expect(statusCode("ok")).toBe(200);
    expect(statusCode("notFound")).toBe(404);
    expect(statusCode("unprocessableEntity")).toBe(422);
  });

  /** A controller writing `status: 404` is not wrong. */
  it("passes a number through", () => {
    expect(statusCode(404)).toBe(404);
  });

  it("knows the ones people reach for", () => {
    expect(statusCode("created")).toBe(201);
    expect(statusCode("noContent")).toBe(204);
    expect(statusCode("seeOther")).toBe(303);
    expect(statusCode("notModified")).toBe(304);
    expect(statusCode("forbidden")).toBe(403);
    expect(statusCode("conflict")).toBe(409);
    expect(statusCode("tooManyRequests")).toBe(429);
    expect(statusCode("internalServerError")).toBe(500);
  });
});

describe("statusMessage", () => {
  it("gives the reason phrase", () => {
    expect(statusMessage("ok")).toBe("OK");
    expect(statusMessage(404)).toBe("Not Found");
    expect(statusMessage("unprocessableEntity")).toBe("Unprocessable Entity");
  });

  it("gives an empty string for a number it does not know", () => {
    expect(statusMessage(299)).toBe("");
  });

  it("writes the pair the way a log does", () => {
    expect(codeAndName("notFound")).toBe("404 Not Found");
  });
});

describe("the ranges", () => {
  it("classifies informational", () => {
    expect(isInformational("continue")).toBe(true);
    expect(isInformational("ok")).toBe(false);
  });

  it("classifies success", () => {
    expect(isSuccessful("ok")).toBe(true);
    expect(isSuccessful("created")).toBe(true);
    expect(isSuccessful("notFound")).toBe(false);
  });

  it("classifies redirection", () => {
    expect(isRedirection("movedPermanently")).toBe(true);
    expect(isRedirection("notModified")).toBe(true);
    expect(isRedirection("ok")).toBe(false);
  });

  it("classifies client error", () => {
    expect(isClientError("notFound")).toBe(true);
    expect(isClientError("internalServerError")).toBe(false);
  });

  it("classifies server error", () => {
    expect(isServerError("internalServerError")).toBe(true);
    expect(isServerError("notFound")).toBe(false);
  });

  it("agrees with itself at the boundaries", () => {
    expect(isSuccessful(200)).toBe(true);
    expect(isSuccessful(299)).toBe(true);
    expect(isSuccessful(300)).toBe(false);
    expect(isRedirection(300)).toBe(true);
  });
});

describe("allowsBody", () => {
  /**
   * Not cosmetic: a 204 with bytes after it desynchronises a keep-alive
   * connection, because the client stops reading where the spec says the
   * response ended and reads the body as the next response.
   */
  it("refuses a body on 204", () => {
    expect(allowsBody("noContent")).toBe(false);
  });

  it("refuses a body on 304", () => {
    expect(allowsBody("notModified")).toBe(false);
  });

  it("refuses a body on the 1xx range", () => {
    expect(allowsBody("continue")).toBe(false);
    expect(allowsBody("switchingProtocols")).toBe(false);
    expect(allowsBody("earlyHints")).toBe(false);
  });

  it("allows one everywhere else", () => {
    expect(allowsBody("ok")).toBe(true);
    expect(allowsBody("created")).toBe(true);
    expect(allowsBody("notFound")).toBe(true);
    expect(allowsBody("internalServerError")).toBe(true);
  });
});

describe("the table itself", () => {
  it("reports which names it knows", () => {
    expect(statusRegistered("ok")).toBe(true);
    expect(statusRegistered("teapot")).toBe(false);
  });

  it("lists them", () => {
    expect(statusNames()).toContain("unprocessableEntity");
    expect(statusNames().length).toBeGreaterThan(50);
  });

  /** A duplicated number would make two names silently interchangeable. */
  it("maps each name to its own number", () => {
    const codes = Object.values(STATUS_CODES);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has a reason phrase for every name", () => {
    for (const name of statusNames()) {
      expect(statusMessage(name), name).not.toBe("");
    }
  });
});
