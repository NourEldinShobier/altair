/**
 * Connection identity, ported from
 * `actioncable/test/connection/identifier_test.rb` and
 * `remote_connections_test.rb`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectionContext } from "../src/channel.js";
import {
  connectedIdentifiers,
  connectionCount,
  connectionIdentifier,
  connectionIdentifiers,
  disconnectAll,
  identifiedBy,
  isConnected,
  openConnectionsStatistics,
  resetConnections,
  resetIdentifiers,
  trackConnection,
} from "../src/identity.js";

function context(extra: Record<string, unknown> = {}): ConnectionContext {
  return { request: new Request("https://example.com/cable"), ...extra };
}

beforeEach(() => {
  resetIdentifiers();
  resetConnections();
});

afterEach(() => {
  resetIdentifiers();
  resetConnections();
});

describe("identifiedBy", () => {
  it("records the declaration", () => {
    identifiedBy("currentUser");

    expect(connectionIdentifiers().map((one) => one.name)).toEqual(["currentUser"]);
  });

  it("builds an identifier from the connection", () => {
    identifiedBy("currentUser", (user) => `user:${String((user as { id: number }).id)}`);

    expect(connectionIdentifier(context({ currentUser: { id: 7 } }))).toBe("user:7");
  });

  /** Rails joins several identifiers into one name. */
  it("joins several", () => {
    identifiedBy("currentUser", (user) => `user:${String((user as { id: number }).id)}`);
    identifiedBy(
      "currentAccount",
      (account) => `account:${String((account as { id: number }).id)}`,
    );

    expect(
      connectionIdentifier(context({ currentUser: { id: 7 }, currentAccount: { id: 2 } })),
    ).toBe("user:7:account:2");
  });

  it("skips an attribute the connection does not carry", () => {
    identifiedBy("currentUser", (user) => `user:${String((user as { id: number }).id)}`);
    identifiedBy("currentAccount", () => "never");

    expect(connectionIdentifier(context({ currentUser: { id: 7 } }))).toBe("user:7");
  });

  /**
   * An anonymous visitor on a public channel is a real state, not an error —
   * such a connection simply cannot be found by name later.
   */
  it("gives undefined when nothing identifies the connection", () => {
    identifiedBy("currentUser");

    expect(connectionIdentifier(context())).toBeUndefined();
  });

  it("gives undefined when nothing was declared", () => {
    expect(connectionIdentifier(context({ currentUser: { id: 1 } }))).toBeUndefined();
  });
});

describe("tracking", () => {
  it("reports a connected identity", () => {
    trackConnection("user:1", () => {});

    expect(isConnected("user:1")).toBe(true);
    expect(isConnected("user:2")).toBe(false);
  });

  it("lists the connected identities once each", () => {
    trackConnection("user:1", () => {});
    trackConnection("user:1", () => {});
    trackConnection("user:2", () => {});

    expect(connectedIdentifiers().sort()).toEqual(["user:1", "user:2"]);
  });

  /** One per open tab, which is why the count is separate from the list. */
  it("counts the sockets one identity holds", () => {
    trackConnection("user:1", () => {});
    trackConnection("user:1", () => {});

    expect(connectionCount("user:1")).toBe(2);
    expect(connectionCount("user:2")).toBe(0);
  });

  it("forgets a connection that released itself", () => {
    const release = trackConnection("user:1", () => {});
    release();

    expect(isConnected("user:1")).toBe(false);
  });

  it("reports what the process is holding", () => {
    trackConnection("user:1", () => {});
    trackConnection("user:1", () => {});
    trackConnection("user:2", () => {});

    expect(
      openConnectionsStatistics().sort((a, b) => a.identifier.localeCompare(b.identifier)),
    ).toEqual([
      { identifier: "user:1", count: 2 },
      { identifier: "user:2", count: 1 },
    ]);
  });
});

describe("disconnectAll", () => {
  /**
   * All of them, not one: a revoked session must not survive because the user
   * had a second tab open.
   */
  it("disconnects every socket under the identity", () => {
    let disconnected = 0;
    trackConnection("user:1", () => {
      disconnected += 1;
    });
    trackConnection("user:1", () => {
      disconnected += 1;
    });

    disconnectAll("user:1");

    expect(disconnected).toBe(2);
  });

  it("reports how many it closed", () => {
    trackConnection("user:1", () => {});
    trackConnection("user:1", () => {});

    expect(disconnectAll("user:1")).toBe(2);
  });

  it("leaves other identities alone", () => {
    let other = 0;
    trackConnection("user:1", () => {});
    trackConnection("user:2", () => {
      other += 1;
    });

    disconnectAll("user:1");

    expect(other).toBe(0);
    expect(isConnected("user:2")).toBe(true);
  });

  it("forgets them afterwards", () => {
    trackConnection("user:1", () => {});
    disconnectAll("user:1");

    expect(isConnected("user:1")).toBe(false);
  });

  it("does nothing for an identity nobody holds", () => {
    expect(disconnectAll("user:9")).toBe(0);
  });
});
