/**
 * Purging a blob in the background, ported from `ActiveStorage::PurgeJob`.
 *
 * Deleting bytes is a round trip to the service, and a record with twenty
 * attachments is twenty of them. Doing that inside a `destroy` makes the
 * person who pressed the button wait for every one, and makes the request
 * fail if the service is briefly unreachable — for work whose result nobody
 * is waiting to see.
 *
 * Not the default. Enqueuing needs a queue adapter, and production has none
 * until an application configures one; a default that turned every `destroy`
 * into an error in production would be a worse trade than the wait.
 */

import { Job } from "@altair/jobs";
import { StorageBlob } from "./blob.js";

export class PurgeBlobJob extends Job {
  override async perform(id: number): Promise<void> {
    // Gone already is the goal, not an error: two purges racing, or a retry
    // after the first attempt got as far as deleting the row.
    const blob = await StorageBlob.where({ id }).first();
    if (blob) await blob.purge();
  }
}
