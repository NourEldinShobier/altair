/**
 * The defaults a mailer has before anybody configures one.
 *
 * Mirrors the job actionmailer/test/base_test.rb does for delivery methods.
 */

import { describe, expect, it } from "bun:test";
import { defaultDelivery } from "../src/mailer.js";
import { LogDelivery, TestDelivery, UnconfiguredDelivery } from "../src/message.js";

/**
 * Which delivery method an environment gets when nothing sets one.
 *
 * Rails sets this per environment in the config it generates, which is why a
 * generated Rails application can send mail on the first day. This had no
 * default at all, so `deliverNow()` in a freshly generated application threw
 * on the message it was asked to send.
 */
describe("the default delivery method", () => {
  it("collects in test, so a case can assert on what was sent", async () => {
    const delivery = defaultDelivery("test");

    expect(delivery).toBeInstanceOf(TestDelivery);

    await delivery.sendMail({ to: "a@example.com", subject: "Hi" } as never);
    expect((delivery as TestDelivery).deliveries).toHaveLength(1);
  });

  // Written where somebody can read it, rather than sent to an SMTP server
  // that is not there.
  it("writes to the terminal in development", () => {
    expect(defaultDelivery("development")).toBeInstanceOf(LogDelivery);
  });

  /**
   * The one environment that keeps refusing. A default that logged here would
   * drop mail silently, which is the failure nobody notices until a customer
   * asks where their receipt went.
   */
  it("refuses in production", async () => {
    const delivery = defaultDelivery("production");

    expect(delivery).toBeInstanceOf(UnconfiguredDelivery);
    await expect(delivery.sendMail({} as never)).rejects.toThrow("No delivery method");
  });
});
