/**
 * Asserting what went out over the cable, ported from
 * `actioncable/test/test_helper_test.rb`.
 *
 * The hand-written version stands up a socket, subscribes it and waits for a
 * frame — which tests the transport rather than the thing under test, and is
 * slow and flaky besides.
 */

import { describe, expect, it } from "bun:test";
import { AssertionFailed } from "@altair/support";
import {
  assertBroadcastOn,
  assertBroadcasts,
  assertNoBroadcasts,
  Cable,
  captureBroadcasts,
  RecordingBroadcaster,
  type Broadcaster,
} from "../src/index.js";

describe("counting what went out", () => {
  it("counts the broadcasts on one stream", async () => {
    const cable = new Cable();

    await assertBroadcasts(cable, "chat:1", 2, () => {
      cable.broadcastTo("chat:1", { body: "one" });
      cable.broadcastTo("chat:1", { body: "two" });
    });
  });

  it("ignores the broadcasts on other streams", async () => {
    const cable = new Cable();

    await assertBroadcasts(cable, "chat:1", 1, () => {
      cable.broadcastTo("chat:1", { body: "mine" });
      cable.broadcastTo("chat:2", { body: "theirs" });
    });
  });

  it("says how many there actually were", async () => {
    const cable = new Cable();

    await expect(
      assertBroadcasts(cable, "chat:1", 2, () => {
        cable.broadcastTo("chat:1", { body: "one" });
      }),
    ).rejects.toThrow(/Expected 2 broadcast\(s\).*got 1/);
  });

  it("passes when nothing went out and nothing should have", async () => {
    const cable = new Cable();

    await assertNoBroadcasts(cable, "chat:1", () => {
      cable.broadcastTo("chat:2", { body: "elsewhere" });
    });
  });

  it("fails when something went out that should not have", async () => {
    const cable = new Cable();

    await expect(
      assertNoBroadcasts(cable, "chat:1", () => {
        cable.broadcastTo("chat:1", { body: "oops" });
      }),
    ).rejects.toBeInstanceOf(AssertionFailed);
  });
});

describe("matching a particular message", () => {
  it("finds it among several", async () => {
    const cable = new Cable();

    await assertBroadcastOn(cable, "chat:1", { body: "two" }, () => {
      cable.broadcastTo("chat:1", { body: "one" });
      cable.broadcastTo("chat:1", { body: "two" });
    });
  });

  /**
   * "No broadcast matched" sends you looking for a missing call when the
   * answer is usually one field spelled differently, so the message says what
   * did go out.
   */
  it("shows what did go out when nothing matched", async () => {
    const cable = new Cable();

    await expect(
      assertBroadcastOn(cable, "chat:1", { body: "two" }, () => {
        cable.broadcastTo("chat:1", { body: "one" });
      }),
    ).rejects.toThrow(/"body":"one"/);
  });

  it("says the stream was silent when it was", async () => {
    const cable = new Cable();

    await expect(assertBroadcastOn(cable, "chat:1", { a: 1 }, () => {})).rejects.toThrow(
      /Nothing was broadcast/,
    );
  });
});

describe("capturing them for a closer look", () => {
  it("hands back the messages in order", async () => {
    const cable = new Cable();

    const seen = await captureBroadcasts(cable, "chat:1", () => {
      cable.broadcastTo("chat:1", { n: 1 });
      cable.broadcastTo("chat:1", { n: 2 });
    });

    expect(seen.map((one) => one.message)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("takes every stream when given no name", async () => {
    const cable = new Cable();

    const seen = await captureBroadcasts(cable, () => {
      cable.broadcastTo("a", 1);
      cable.broadcastTo("b", 2);
    });

    expect(seen.map((one) => one.stream)).toEqual(["a", "b"]);
  });
});

describe("the recorder itself", () => {
  /**
   * Rails' test adapter swaps delivery out entirely. There is no reason to,
   * and a test that asserts a broadcast *and* its receipt should not have to
   * choose between them.
   */
  it("passes the broadcast along rather than swallowing it", async () => {
    const cable = new Cable();
    const delivered: string[] = [];
    const inner: Broadcaster = { publish: (topic) => void delivered.push(topic) };

    cable.useBroadcaster(inner);

    await captureBroadcasts(cable, "chat:1", () => {
      cable.broadcastTo("chat:1", { body: "hi" });
    });

    expect(delivered).toHaveLength(1);
  });

  it("puts the real broadcaster back afterwards", async () => {
    const cable = new Cable();
    const before = cable.broadcaster;

    await captureBroadcasts(cable, "chat:1", () => {});

    expect(cable.broadcaster).toBe(before);
  });

  /**
   * Or a block that throws leaves the recorder in place and every later test
   * in the file quietly counts its broadcasts too.
   */
  it("puts it back even when the block throws", async () => {
    const cable = new Cable();
    const before = cable.broadcaster;

    await captureBroadcasts(cable, "chat:1", () => {
      throw new Error("nope");
    }).catch(() => undefined);

    expect(cable.broadcaster).toBe(before);
  });

  it("still counts a payload it cannot read", () => {
    const recorder = new RecordingBroadcaster();
    recorder.publish("topic", "not json");

    expect(recorder.broadcasts).toHaveLength(1);
  });
});
