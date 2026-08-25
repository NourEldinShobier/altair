/**
 * `has_one through`.
 *
 * Mirrors activerecord/test/cases/associations/has_one_through_associations_test.rb.
 *
 * The hops are the same as `hasManyThrough` — load the middle, then the target
 * from the middle, two queries however many owners there are. What differs is
 * what is kept at the end: the first record reached, or null, rather than a
 * list. A user's address through their profile is the shape.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { notifications } from "@altair/support";
import { Connection, Model, SchemaStatements, setConnection } from "../src/index.js";

interface UserRow {
  id: number;
  name: string;
}
interface ProfileRow {
  id: number;
  user_id: number;
  address_id: number | null;
}
interface AddressRow {
  id: number;
  city: string;
}

class Address extends Model<AddressRow>("addresses") {}

class Profile extends Model<ProfileRow>("profiles") {
  declare address: () => Promise<Address | null>;
  static {
    this.belongsTo("address", () => Address);
  }
}

class User extends Model<UserRow>("users") {
  declare profile: () => Promise<Profile | null>;
  declare address: () => Promise<Address | null>;
  static {
    this.hasOne("profile", () => Profile);
    this.hasOneThrough("address", "profile");
  }
}

let connection: Connection;
let ada: User;
let grace: User;
let alan: User;

beforeEach(async () => {
  connection = new Connection(process.env.DATABASE_URL ?? "sqlite://:memory:");
  setConnection(connection);

  for (const model of [User, Profile, Address]) {
    model.columnCache = undefined;
    model.columnTypeCache = undefined;
  }

  const schema = new SchemaStatements(connection);

  for (const table of ["addresses", "profiles", "users"]) {
    await schema.dropTable(table, { ifExists: true });
  }

  await schema.createTable("addresses", (t) => t.string("city"));
  await schema.createTable("profiles", (t) => {
    t.bigint("user_id");
    t.bigint("address_id");
  });
  await schema.createTable("users", (t) => t.string("name"));

  const london = await Address.create({ city: "London" });

  ada = await User.create({ name: "Ada" });
  await Profile.create({ user_id: ada.id, address_id: london.id });

  // No profile at all, so the chain stops at the first hop.
  grace = await User.create({ name: "Grace" });

  // A profile whose address is missing, so it stops at the second.
  alan = await User.create({ name: "Alan" });
  await Profile.create({ user_id: alan.id, address_id: null });
});

describe("reading it on its own", () => {
  it("reaches the far side", async () => {
    expect(((await ada.address()) as Address).city).toBe("London");
  });

  it("is a record and not a list", async () => {
    expect(Array.isArray(await ada.address())).toBe(false);
  });

  // Both ways of reaching nothing, since they take different paths through
  // the loader: one stops before the middle, the other after it.
  it("is null when the middle is missing", async () => {
    expect(await grace.address()).toBeNull();
  });

  it("is null when the far side is missing", async () => {
    expect(await alan.address()).toBeNull();
  });

  it("leaves the association it travels through alone", async () => {
    expect(((await ada.profile()) as Profile).user_id).toBe(ada.id);
  });
});

describe("preloading it", () => {
  it("reaches the far side without another query", async () => {
    const users = await User.all().includes("address").order("id");
    const first = users[0] as User;

    expect(((await first.address()) as Address).city).toBe("London");
  });

  it("gives null for the owners that reach nothing", async () => {
    const users = await User.all().includes("address").order("id");

    expect(await (users[1] as User).address()).toBeNull();
    expect(await (users[2] as User).address()).toBeNull();
  });

  // A loaded association can legitimately be null, so "already loaded" cannot
  // mean "is an array" — otherwise a chain reaching nothing is looked up again
  // on every read, which is the N+1 the preload existed to remove.
  it("does not go back for an owner whose answer was nothing", async () => {
    const users = await User.all().includes("address").order("id");
    const withoutOne = users[1] as User;

    // Counted off the instrumentation bus, which every statement reports on.
    // A `queryCount` property would have been simpler and does not exist, and
    // the version of this test that asked for one passed by subtracting
    // undefined from undefined.
    let queries = 0;
    const subscription = notifications.subscribe("sql.altair", () => {
      queries += 1;
    });

    try {
      await withoutOne.address();
      await withoutOne.address();
    } finally {
      subscription.unsubscribe();
    }

    expect(queries).toBe(0);
  });

  it("counts the preload itself, so the counter is known to work", async () => {
    let queries = 0;
    const subscription = notifications.subscribe("sql.altair", () => {
      queries += 1;
    });

    try {
      await User.all().includes("address").order("id");
    } finally {
      subscription.unsubscribe();
    }

    // The owners, the profiles, the addresses: three, however many users.
    expect(queries).toBe(3);
  });
});
