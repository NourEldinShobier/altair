/**
 * Choosing a delivery method and deciding what a failure means, ported from
 * `actionmailer/test/base_test.rb` — the `delivery_method`,
 * `wrap_delivery_behavior` and `rescue_from` cases.
 *
 * The failure worth designing against is a test suite that sends real mail. A
 * delivery method resolved by a typo, or one that falls back when it cannot
 * find what it was asked for, mails real customers and nobody finds out from a
 * failing assertion.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { MessageFields } from "../src/message.js";
import {
  INTERNAL_METHODS,
  UnknownDeliveryMethod,
  UnknownMailer,
  actionMethods,
  addDeliveryMethod,
  aroundDeliver,
  aroundDeliveryHooks,
  clearAroundDeliveryHooks,
  clearCustom,
  clearExceptionRules,
  clearNamedObservers,
  customFor,
  deliverMail,
  deliveryMethodNames,
  determineDefaultMailer,
  exceptionRules,
  handleException,
  handleExceptions,
  internalMethods,
  mailerClass,
  namedObservers,
  notifyNamedObservers,
  observerClassFor,
  readFixture,
  registerMailer,
  registerNamedObserver,
  removeDeliveryMethod,
  resetDeliveryMethods,
  resetMailers,
  setCustom,
  wrapDeliveryBehavior,
} from "../src/delivery_registry.js";

afterEach(() => {
  resetDeliveryMethods();
  resetMailers();
  clearExceptionRules();
  clearAroundDeliveryHooks();
  clearNamedObservers();
  clearCustom();
});

const message: MessageFields = { to: "someone@app.test", subject: "Hello" };

const named = (name: string) => {
  const error = new Error("boom");
  error.name = name;

  return error;
};

describe("registering a delivery method", () => {
  it("builds one that was registered", () => {
    addDeliveryMethod("test", () => ({ sendMail: async () => undefined }));

    expect(wrapDeliveryBehavior("test")).toBeDefined();
  });

  it("passes the settings through", () => {
    let seen: Record<string, unknown> = {};
    addDeliveryMethod("smtp", (settings) => {
      seen = settings;

      return { sendMail: async () => undefined };
    });

    wrapDeliveryBehavior("smtp", { host: "mail.test" });

    expect(seen).toEqual({ host: "mail.test" });
  });

  /**
   * The whole point. A typo that quietly resolves to the real SMTP method is
   * how a test suite mails a customer.
   */
  it("refuses a name nobody registered", () => {
    expect(() => wrapDeliveryBehavior("smpt")).toThrow(UnknownDeliveryMethod);
  });

  it("says what there is instead", () => {
    addDeliveryMethod("test", () => ({ sendMail: async () => undefined }));

    expect(() => wrapDeliveryBehavior("smpt")).toThrow("test");
  });

  it("says why the failure matters", () => {
    expect(() => wrapDeliveryBehavior("smpt")).toThrow("real mail");
  });

  it("lists what is registered", () => {
    addDeliveryMethod("b", () => ({ sendMail: async () => undefined }));
    addDeliveryMethod("a", () => ({ sendMail: async () => undefined }));

    expect(deliveryMethodNames()).toEqual(["a", "b"]);
  });

  it("removes one", () => {
    addDeliveryMethod("test", () => ({ sendMail: async () => undefined }));

    expect(removeDeliveryMethod("test")).toBe(true);
    expect(deliveryMethodNames()).toEqual([]);
  });

  it("says when there was nothing to remove", () => {
    expect(removeDeliveryMethod("never")).toBe(false);
  });
});

describe("what a failed delivery means", () => {
  /**
   * A mailer that swallows its own failures reports success for every message
   * it never sent, and the first anybody knows is a support ticket about a
   * missing password reset.
   */
  it("raises by default", () => {
    expect(handleExceptions(named("SMTPError"))).toBe("raise");
  });

  it("takes a rule for one error", () => {
    handleException("SMTPError", "retry");

    expect(handleExceptions(named("SMTPError"))).toBe("retry");
  });

  it("leaves other errors raising", () => {
    handleException("SMTPError", "retry");

    expect(handleExceptions(named("Whatever"))).toBe("raise");
  });

  it("takes a catch-all", () => {
    handleException("*", "discard");

    expect(handleExceptions(named("Anything"))).toBe("discard");
  });

  /** Or a catch-all added at boot would win over a specific rule added later. */
  it("prefers a specific rule over a catch-all whichever was added first", () => {
    handleException("*", "discard");
    handleException("SMTPError", "retry");

    expect(handleExceptions(named("SMTPError"))).toBe("retry");
  });

  it("prefers it the other way round too", () => {
    handleException("SMTPError", "retry");
    handleException("*", "discard");

    expect(handleExceptions(named("SMTPError"))).toBe("retry");
  });

  it("lists its rules", () => {
    handleException("SMTPError", "retry");

    expect(exceptionRules()).toHaveLength(1);
  });

  it("survives something thrown that is not an error", () => {
    expect(handleExceptions("just a string")).toBe("raise");
  });
});

describe("sending", () => {
  it("sends the message", async () => {
    const sent: MessageFields[] = [];

    const result = await deliverMail(message, {
      sendMail: async (each) => void sent.push(each),
    });

    expect(result).toBe("delivered");
    expect(sent).toEqual([message]);
  });

  it("runs a hook around it", async () => {
    const order: string[] = [];
    aroundDeliver(async (_message, deliver) => {
      order.push("before");
      await deliver();
      order.push("after");
    });

    await deliverMail(message, { sendMail: async () => void order.push("send") });

    expect(order).toEqual(["before", "send", "after"]);
  });

  /**
   * A timing hook added at boot has to actually measure the retry hook a
   * feature added later, which means the earlier one wraps the later one.
   */
  it("nests hooks outermost first", async () => {
    const order: string[] = [];
    aroundDeliver(async (_message, deliver) => {
      order.push("outer in");
      await deliver();
      order.push("outer out");
    });
    aroundDeliver(async (_message, deliver) => {
      order.push("inner in");
      await deliver();
      order.push("inner out");
    });

    await deliverMail(message, { sendMail: async () => void order.push("send") });

    expect(order).toEqual(["outer in", "inner in", "send", "inner out", "outer out"]);
  });

  it("lets a hook stop the delivery", async () => {
    let sent = false;
    aroundDeliver(async () => undefined);

    await deliverMail(message, { sendMail: async () => void (sent = true) });

    expect(sent).toBe(false);
  });

  it("lists the hooks", () => {
    aroundDeliver(async (_message, deliver) => deliver());

    expect(aroundDeliveryHooks()).toHaveLength(1);
  });

  it("raises what the delivery threw when nothing says otherwise", async () => {
    await expect(
      deliverMail(message, {
        sendMail: async () => {
          throw named("SMTPError");
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("reports a retry rather than raising when told to", async () => {
    handleException("SMTPError", "retry");

    expect(
      await deliverMail(message, {
        sendMail: async () => {
          throw named("SMTPError");
        },
      }),
    ).toBe("retry");
  });

  it("reports a discard", async () => {
    handleException("SMTPError", "discard");

    expect(
      await deliverMail(message, {
        sendMail: async () => {
          throw named("SMTPError");
        },
      }),
    ).toBe("discard");
  });
});

describe("finding a mailer", () => {
  it("finds one that was registered", () => {
    registerMailer("UserMailer", "the mailer");

    expect(mailerClass("UserMailer")).toBe("the mailer");
    expect(determineDefaultMailer("UserMailer")).toBe("the mailer");
  });

  it("reports nothing for one that was not", () => {
    expect(mailerClass("Nope")).toBeUndefined();
  });

  /**
   * A mailer resolved by convention from something that was renamed fails at
   * send time — inside a job, on a queue, with a stack that names the queue.
   */
  it("refuses to guess", () => {
    expect(() => determineDefaultMailer("Nope")).toThrow(UnknownMailer);
  });

  it("says what there is", () => {
    registerMailer("UserMailer", "x");

    expect(() => determineDefaultMailer("Nope")).toThrow("UserMailer");
  });
});

describe("which methods are actions", () => {
  /**
   * Every public method becomes a mail-sending action, so `attachments` being
   * routable produces a mail with no template and an exception nobody can
   * place.
   */
  it("leaves the framework's own out", () => {
    expect(actionMethods(["welcome", "attachments", "headers", "mail"])).toEqual(["welcome"]);
  });

  it("leaves private-looking ones out", () => {
    expect(actionMethods(["welcome", "_helper", "#secret"])).toEqual(["welcome"]);
  });

  it("keeps every other one", () => {
    expect(actionMethods(["welcome", "goodbye"])).toEqual(["welcome", "goodbye"]);
  });

  it("names the internal ones", () => {
    expect(internalMethods().has("mail")).toBe(true);
    expect(INTERNAL_METHODS.has("welcome")).toBe(false);
  });
});

describe("reading a fixture", () => {
  it("splits it into lines", () => {
    expect(readFixture("one\ntwo")).toEqual(["one", "two"]);
  });

  /**
   * A fixture read one way and a template rendered the other differ by a
   * newline nobody can see, and the failure shows two identical-looking
   * strings.
   */
  it("drops the trailing newline but keeps trailing spaces", () => {
    expect(readFixture("one\ntwo  \n")).toEqual(["one", "two  "]);
  });

  it("keeps a blank line in the middle", () => {
    expect(readFixture("one\n\ntwo")).toEqual(["one", "", "two"]);
  });
});

describe("named observers", () => {
  /** An application that registers one twice on a reload counts every mail twice. */
  it("keeps one per name", () => {
    registerNamedObserver("metrics", { delivered: () => undefined });
    registerNamedObserver("metrics", { delivered: () => undefined });

    expect(namedObservers()).toHaveLength(1);
  });

  it("finds one by name", () => {
    const observer = { delivered: () => undefined };
    registerNamedObserver("metrics", observer);

    expect(observerClassFor("metrics")).toBe(observer);
  });

  it("reports nothing for a name nobody used", () => {
    expect(observerClassFor("nope")).toBeUndefined();
  });

  it("tells each of them", async () => {
    const seen: string[] = [];
    registerNamedObserver("one", { delivered: () => void seen.push("one") });
    registerNamedObserver("two", { delivered: () => void seen.push("two") });

    await notifyNamedObservers(message);

    expect(seen).toEqual(["one", "two"]);
  });

  /**
   * The mail has already been sent. Raising here reports a failure for
   * something that succeeded, and a retry would send it twice.
   */
  it("does not let one failing stop the others", async () => {
    const seen: string[] = [];
    registerNamedObserver("bad", {
      delivered: () => {
        throw new Error("observer broke");
      },
    });
    registerNamedObserver("good", { delivered: () => void seen.push("good") });

    await expect(notifyNamedObservers(message)).resolves.toBeUndefined();
    expect(seen).toEqual(["good"]);
  });
});

describe("per-mailer settings", () => {
  it("holds what was set", () => {
    setCustom("UserMailer", { from: "noreply@app.test" });

    expect(customFor("UserMailer")).toEqual({ from: "noreply@app.test" });
  });

  it("merges rather than replacing", () => {
    setCustom("UserMailer", { from: "a@app.test" });
    setCustom("UserMailer", { replyTo: "b@app.test" });

    expect(customFor("UserMailer")).toEqual({ from: "a@app.test", replyTo: "b@app.test" });
  });

  it("keeps mailers apart", () => {
    setCustom("UserMailer", { from: "a@app.test" });

    expect(customFor("OrderMailer")).toEqual({});
  });

  it("gives a copy, so a caller cannot write through it", () => {
    setCustom("UserMailer", { from: "a@app.test" });

    customFor("UserMailer")["from"] = "changed";

    expect(customFor("UserMailer")["from"]).toBe("a@app.test");
  });
});
