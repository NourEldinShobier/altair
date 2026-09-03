/**
 * Controlling the clock, and checking what was enqueued.
 *
 * Mirrors activesupport/test/testing/time_helpers_test.rb and
 * activejob/test/cases/test_helper_test.rb. The restoration tests matter most:
 * a helper that leaves the clock moved or the queue swapped breaks every test
 * after it, and the failure appears in a file that never touched either.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Connection, Model, SchemaStatements, setConnection } from "@altair/orm";
import { Job, MemoryQueue } from "@altair/jobs";
import { advanceClock, freezeTime, isTimeFrozen, travel, travelTo } from "@altair/support";
import { capturingJobs } from "../src/jobs.js";

const MOMENT = new Date("2026-06-01T12:00:00.000Z");

describe("holding the clock", () => {
  it("makes now the moment it was given", async () => {
    await travelTo(MOMENT, () => {
      expect(new Date().toISOString()).toBe("2026-06-01T12:00:00.000Z");
      expect(Date.now()).toBe(MOMENT.getTime());
    });
  });

  it("holds it still across an await", async () => {
    await travelTo(MOMENT, async () => {
      const before = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(Date.now()).toBe(before);
    });
  });

  // A subclass rather than a replacement, so everything a library reaches for
  // keeps working.
  it("leaves the rest of Date alone", async () => {
    await travelTo(MOMENT, () => {
      expect(new Date() instanceof Date).toBe(true);
      expect(new Date("2020-01-01").getFullYear()).toBe(2020);
      expect(Date.parse("2020-01-01T00:00:00Z")).toBe(1577836800000);
    });
  });

  it("puts it back afterwards", async () => {
    await travelTo(MOMENT, () => undefined);

    expect(isTimeFrozen()).toBe(false);
    expect(Math.abs(Date.now() - Date.now())).toBeLessThan(50);
  });

  // The whole safety of the thing. A test that left the clock moved would put
  // every test after it in the wrong year.
  it("puts it back even when the block throws", async () => {
    await travelTo(MOMENT, () => {
      throw new Error("something went wrong");
    }).catch(() => undefined);

    expect(isTimeFrozen()).toBe(false);
  });

  it("freezes where it is", async () => {
    await freezeTime(async () => {
      const before = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(Date.now()).toBe(before);
    });
  });

  it("travels forward by seconds", async () => {
    const before = Date.now();

    await travel(3600, () => {
      expect(Date.now() - before).toBeGreaterThanOrEqual(3600 * 1000);
    });
  });

  it("nests, and the inner one wins", async () => {
    await travelTo(MOMENT, async () => {
      await travelTo(new Date("2030-01-01T00:00:00Z"), () => {
        expect(new Date().getFullYear()).toBe(2030);
      });

      expect(new Date().getFullYear()).toBe(2026);
    });
  });

  // The shape a test actually wants: do something, let an hour pass, check
  // what expired.
  it("advances without leaving the block", async () => {
    await travelTo(MOMENT, () => {
      advanceClock(3600);

      expect(new Date().toISOString()).toBe("2026-06-01T13:00:00.000Z");
    });
  });

  it("says so when asked to advance a clock nobody held", () => {
    expect(() => advanceClock(60)).toThrow(/travelTo or freezeTime/);
  });
});

// The reason this exists. This repository had a file that slept 1.1 seconds
// per assertion — seven seconds on each of three adapters — to prove a
// timestamp had moved.
describe("what it replaces", () => {
  interface PostRow {
    id: number;
    title: string;
    updated_at: Date;
  }

  class Post extends Model<PostRow>("posts") {}

  beforeEach(async () => {
    const connection = new Connection("sqlite://:memory:");
    setConnection(connection);
    Post.resetColumnInformation();

    await new SchemaStatements(connection).createTable("posts", (t) => {
      t.string("title");
      t.datetime("updated_at");
    });
  });

  it("proves a timestamp moved, with no sleeping", async () => {
    const post = await travelTo(MOMENT, async () => await Post.create({ title: "A" }));
    const before = post.cacheKey();

    await travelTo(new Date("2026-06-01T12:00:05.000Z"), async () => {
      await post.touch();
    });

    expect(post.cacheKey()).not.toBe(before);
    expect(String(post.updated_at)).toContain("12:00:05");
  });
});

describe("capturing jobs", () => {
  class ChargeCard extends Job {
    override async perform(): Promise<void> {}
  }

  class SendReceipt extends Job {
    override async perform(): Promise<void> {}
  }

  let queue: MemoryQueue;

  beforeEach(() => {
    queue = new MemoryQueue();
    Job.adapter = queue;
    Job.resetRegistry();
    Job.register(ChargeCard as never, SendReceipt as never);
  });

  afterEach(() => {
    Job.adapter = queue;
  });

  it("records what was enqueued", async () => {
    const enqueued = await capturingJobs(Job, async () => {
      await ChargeCard.performLater(7);
    });

    expect(enqueued.length).toBe(1);
    expect(enqueued.of(ChargeCard)[0]?.arguments).toEqual([7]);
  });

  it("tells the job classes apart", async () => {
    const enqueued = await capturingJobs(Job, async () => {
      await ChargeCard.performLater(1);
      await SendReceipt.performLater(2);
      await SendReceipt.performLater(3);
    });

    expect(enqueued.of(ChargeCard)).toHaveLength(1);
    expect(enqueued.of(SendReceipt)).toHaveLength(2);
  });

  it("filters by queue", async () => {
    const enqueued = await capturingJobs(Job, async () => {
      await ChargeCard.set({ queue: "urgent" }).performLater(1);
      await SendReceipt.performLater(2);
    });

    expect(enqueued.on("urgent")).toHaveLength(1);
  });

  it("iterates like an array", async () => {
    const enqueued = await capturingJobs(Job, async () => {
      await ChargeCard.performLater(1);
    });

    expect([...enqueued]).toHaveLength(1);
  });

  // Nothing may actually run: a worker finding the job would make the test
  // race with it.
  it("keeps the real queue empty", async () => {
    await capturingJobs(Job, async () => {
      await ChargeCard.performLater(1);
    });

    expect(queue.pending()).toHaveLength(0);
  });

  it("puts the real queue back", async () => {
    await capturingJobs(Job, async () => undefined);

    await ChargeCard.performLater(1);
    expect(queue.pending()).toHaveLength(1);
  });

  // A test that left the application on a capturing queue would make every
  // test after it silently stop delivering.
  it("puts it back even when the block throws", async () => {
    await capturingJobs(Job, () => {
      throw new Error("no");
    }).catch(() => undefined);

    await ChargeCard.performLater(1);
    expect(queue.pending()).toHaveLength(1);
  });
});
