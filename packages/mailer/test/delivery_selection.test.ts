/**
 * Which delivery method an application gets, ported from the
 * `delivery_method` cases in `actionmailer/test/base_test.rb` and
 * `actionmailer/test/delivery_methods_test.rb`.
 *
 * The registry existed and nothing consulted it, so an application could not
 * plug in a transactional-email API however it registered one. These are about
 * the joint, and about the two things that must not happen at it: a suite that
 * sends real mail, and a typo that quietly resolves to something that does.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defaultDelivery, registerBuiltInDeliveryMethods } from "../src/mailer.js";
import { LogDelivery, TestDelivery, UnconfiguredDelivery } from "../src/message.js";
import {
  UnknownDeliveryMethod,
  addDeliveryMethod,
  deliveryMethodNames,
  resetDeliveryMethods,
} from "../src/delivery_registry.js";
import type { DeliveryMethod, MessageFields } from "../src/message.js";

const before = {
  SMTP_URL: process.env.SMTP_URL,
  MAIL_DELIVERY_METHOD: process.env.MAIL_DELIVERY_METHOD,
};

/** A method an application would register for its own provider. */
class ApiDelivery implements DeliveryMethod {
  readonly sent: MessageFields[] = [];

  constructor(readonly settings: Record<string, unknown> = {}) {}

  async sendMail(message: MessageFields): Promise<void> {
    this.sent.push(message);
  }
}

beforeEach(() => {
  delete process.env.SMTP_URL;
  delete process.env.MAIL_DELIVERY_METHOD;

  // Emptied, not refilled: the point of most of these is that asking for a
  // method is what puts the built-in ones back.
  resetDeliveryMethods();
});

afterEach(() => {
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("what the package brings", () => {
  /**
   * On asking, not on import. An import-time side effect makes the order of
   * imports decide what is registered — invisible, and untestable in a suite
   * that shares one process between files.
   */
  it("registers them the first time a method is asked for", () => {
    expect(deliveryMethodNames()).toEqual([]);

    process.env.MAIL_DELIVERY_METHOD = "log";
    defaultDelivery("production");

    expect(deliveryMethodNames()).toEqual(["log", "smtp", "test"]);
  });

  /** Or a second call would replace an application's own smtp with the built-in. */
  it("leaves a name somebody else registered alone", () => {
    addDeliveryMethod("smtp", () => new ApiDelivery());
    registerBuiltInDeliveryMethods();

    process.env.MAIL_DELIVERY_METHOD = "smtp";

    expect(defaultDelivery("production")).toBeInstanceOf(ApiDelivery);
  });

  it("builds smtp from the url it was given", () => {
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";
    process.env.MAIL_DELIVERY_METHOD = "smtp";

    expect(defaultDelivery("production")).toBeDefined();
  });

  /** Naming smtp with nothing to connect to is a configuration mistake, not a default. */
  it("refuses smtp with no url", () => {
    process.env.MAIL_DELIVERY_METHOD = "smtp";

    expect(() => defaultDelivery("production")).toThrow("SMTP_URL");
  });

  /** An empty variable is an unset one that looks set, which is worse. */
  it("refuses smtp with an empty url", () => {
    process.env.MAIL_DELIVERY_METHOD = "smtp";
    process.env.SMTP_URL = "";

    expect(() => defaultDelivery("production")).toThrow("SMTP_URL");
  });

  it("builds the log method", () => {
    process.env.MAIL_DELIVERY_METHOD = "log";

    expect(defaultDelivery("production")).toBeInstanceOf(LogDelivery);
  });
});

describe("a method an application registered", () => {
  it("is used when the variable names it", () => {
    addDeliveryMethod("api", (settings) => new ApiDelivery(settings));
    process.env.MAIL_DELIVERY_METHOD = "api";

    expect(defaultDelivery("production")).toBeInstanceOf(ApiDelivery);
  });

  it("is handed the settings the framework knows about", () => {
    addDeliveryMethod("api", (settings) => new ApiDelivery(settings));
    process.env.MAIL_DELIVERY_METHOD = "api";
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";

    const delivery = defaultDelivery("production") as ApiDelivery;

    expect(delivery.settings["url"]).toBe("smtp://user:pass@mail.example:587");
  });

  /** Which is the whole reason it wins: an API is not reachable over SMTP. */
  it("wins over the smtp url", () => {
    addDeliveryMethod("api", () => new ApiDelivery());
    process.env.MAIL_DELIVERY_METHOD = "api";
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";

    expect(defaultDelivery("production")).toBeInstanceOf(ApiDelivery);
  });

  /** A typo that quietly resolves to the real thing is how a staging box mails a customer. */
  it("is refused when nobody registered it", () => {
    process.env.MAIL_DELIVERY_METHOD = "apii";

    expect(() => defaultDelivery("production")).toThrow(UnknownDeliveryMethod);
  });

  it("says what was registered when it refuses", () => {
    process.env.MAIL_DELIVERY_METHOD = "apii";

    expect(() => defaultDelivery("production")).toThrow("log, smtp, test");
  });
});

describe("a test run", () => {
  /**
   * Before the named method, not after. A variable naming a live method is
   * exactly how a suite ends up mailing real people the first time it runs
   * somewhere with the production variables set.
   */
  it("collects mail whatever the variable says", () => {
    addDeliveryMethod("api", () => new ApiDelivery());
    process.env.MAIL_DELIVERY_METHOD = "api";

    expect(defaultDelivery("test")).toBeInstanceOf(TestDelivery);
  });

  it("collects mail whatever the smtp url says", () => {
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";

    expect(defaultDelivery("test")).toBeInstanceOf(TestDelivery);
  });
});

describe("with no variable naming a method", () => {
  /** Publishing a registry changed nothing for an application that ignores it. */
  it("falls back to the smtp url", () => {
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";

    expect(defaultDelivery("production")).not.toBeInstanceOf(UnconfiguredDelivery);
  });

  it("logs in development", () => {
    expect(defaultDelivery("development")).toBeInstanceOf(LogDelivery);
  });

  it("refuses to pretend in production", () => {
    expect(defaultDelivery("production")).toBeInstanceOf(UnconfiguredDelivery);
  });
});
