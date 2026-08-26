/**
 * Value objects over columns, ported from
 * `activerecord/test/cases/aggregations_test.rb`.
 *
 * Two columns that only mean something together stop being two columns. The
 * arithmetic and formatting that belong to money live on Money rather than
 * being repeated wherever a customer is.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";

/** A value object: two fields that are meaningless apart. */
class Money {
  constructor(
    readonly amount: number,
    readonly currency: string,
  ) {}

  plus(other: Money): Money {
    if (other.currency !== this.currency) throw new Error("Different currencies");
    return new Money(this.amount + other.amount, this.currency);
  }

  toString(): string {
    return `${this.amount.toFixed(2)} ${this.currency}`;
  }
}

class Address {
  constructor(
    readonly street: string,
    readonly city: string,
  ) {}
}

interface CustomerRow {
  id: number;
  name: string;
  balance_amount: number | null;
  balance_currency: string | null;
  address_street: string | null;
  address_city: string | null;
}

class Customer extends Model<CustomerRow>("customers") {
  declare balance: Money | null;
  declare address: Address | null;

  static {
    this.composedOf<Money, { amount: number; currency: string }>("balance", {
      mapping: { balance_amount: "amount", balance_currency: "currency" },
      from: (parts) => new Money(Number(parts.amount), String(parts.currency)),
      to: (money) => ({ amount: money.amount, currency: money.currency }),
    });

    this.composedOf<Address, { street: string; city: string }>("address", {
      mapping: { address_street: "street", address_city: "city" },
      from: (parts) => new Address(String(parts.street), String(parts.city)),
      to: (address) => ({ street: address.street, city: address.city }),
    });
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  Customer.columnCache = undefined;
  Customer.columnTypeCache = undefined;

  await new SchemaStatements(connection).createTable("customers", (t) => {
    t.string("name");
    t.integer("balance_amount");
    t.string("balance_currency");
    t.string("address_street");
    t.string("address_city");
  });
});

afterEach(async () => {
  await connection.close();
});

describe("reading one", () => {
  it("builds the value object from its columns", async () => {
    const customer = await Customer.create({
      name: "Ada",
      balance_amount: 50,
      balance_currency: "GBP",
    });

    expect(customer.balance).toBeInstanceOf(Money);
    expect(customer.balance?.amount).toBe(50);
    expect(customer.balance?.currency).toBe("GBP");
  });

  it("carries the behaviour that belongs to it", async () => {
    const customer = await Customer.create({ balance_amount: 50, balance_currency: "GBP" });

    expect(customer.balance?.plus(new Money(25, "GBP")).toString()).toBe("75.00 GBP");
  });

  /**
   * A value object that changed identity on every read would make `===`
   * useless and quietly break any memo keyed on it.
   */
  it("is the same object while the columns are the same", async () => {
    const customer = await Customer.create({ balance_amount: 50, balance_currency: "GBP" });

    expect(customer.balance).toBe(customer.balance);
  });

  it("is rebuilt when a column changes underneath it", async () => {
    const customer = await Customer.create({ balance_amount: 50, balance_currency: "GBP" });
    const before = customer.balance;

    customer.balance_amount = 75;

    expect(customer.balance).not.toBe(before);
    expect(customer.balance?.amount).toBe(75);
  });

  // Rails' `allow_nil`, and the default here. The alternative is an Address
  // whose every field is null, which has to be checked for anyway and is worse
  // at saying so.
  it("is null when every column it maps is empty", async () => {
    const customer = await Customer.create({ name: "Ada" });

    expect(customer.balance).toBeNull();
    expect(customer.address).toBeNull();
  });

  it("keeps two aggregations on one model apart", async () => {
    const customer = await Customer.create({
      balance_amount: 50,
      balance_currency: "GBP",
      address_street: "1 Main St",
      address_city: "London",
    });

    expect(customer.balance?.amount).toBe(50);
    expect(customer.address?.city).toBe("London");
  });
});

describe("writing one", () => {
  it("takes it apart into its columns", async () => {
    const customer = new Customer({ name: "Ada" });

    customer.balance = new Money(120, "EUR");

    expect(customer.balance_amount).toBe(120);
    expect(customer.balance_currency).toBe("EUR");
  });

  it("survives a round trip through the database", async () => {
    const customer = new Customer({ name: "Ada" });
    customer.address = new Address("1 Main St", "London");
    await customer.save();

    const found = await Customer.find(customer.id);

    expect(found.address?.street).toBe("1 Main St");
    expect(found.address?.city).toBe("London");
  });

  // Half an address left behind is something the next read would build a
  // value object out of.
  it("clears every column it maps when set to null", async () => {
    const customer = await Customer.create({
      address_street: "1 Main St",
      address_city: "London",
    });

    customer.address = null;

    expect(customer.address_street).toBeNull();
    expect(customer.address_city).toBeNull();
    expect(customer.address).toBeNull();
  });

  it("is readable again straight after being written", async () => {
    const customer = new Customer({ name: "Ada" });

    customer.balance = new Money(10, "USD");

    expect(customer.balance?.toString()).toBe("10.00 USD");
  });

  it("is what gets persisted, not the value it replaced", async () => {
    const customer = await Customer.create({ balance_amount: 50, balance_currency: "GBP" });

    customer.balance = new Money(75, "GBP");
    await customer.save();

    expect((await Customer.find(customer.id)).balance?.amount).toBe(75);
  });
});

/**
 * Declaring an aggregation on one model must not reach another — the same
 * copy-on-write rule the callbacks and associations follow.
 */
describe("another model", () => {
  it("does not gain the accessor", () => {
    class Supplier extends Model<{ id: number; name: string }>("suppliers") {}

    expect("balance" in Supplier.prototype).toBe(false);
  });
});
