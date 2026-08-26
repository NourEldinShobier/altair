/**
 * Putting an application's channels on a socket.
 *
 * `altair generate channel Chat` wrote a class and nothing ever served it: no
 * cable was mounted, so the channel could not receive a connection however
 * correct it was. Rails mounts Action Cable in the generated routes for the
 * same reason.
 *
 *     await mountCable(app)
 *
 * Channels come from `app/channels`, as Rails autoloads them, so generating a
 * second one needs no edit anywhere — the alternative is a list an application
 * keeps in step by hand and forgets.
 */

import { Glob } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Cable, type CableOptions } from "./server.js";
import { Channel } from "./channel.js";

/** The part of an application this needs, so cable need not depend on core. */
export interface SocketHost {
  useWebSocket(handler: {
    handles(request: Request): boolean;
    upgradeData(request: Request): Promise<unknown | null>;
    handlers(): unknown;
  }): unknown;
}

export interface MountOptions extends CableOptions {
  /** Where to look for channels. Defaults to the working directory. */
  root?: string;
}

/** Mounts every channel in `app/channels`, and answers what it found. */
export async function mountCable(app: SocketHost, options: MountOptions = {}): Promise<string[]> {
  const root = options.root ?? process.cwd();
  const directory = join(root, "app", "channels");
  const found: (typeof Channel)[] = [];

  // An application with none of these has no directory, which `Glob.scan`
  // reports as ENOENT rather than as an empty result. Not an error: having no
  // channels yet is the ordinary state of a new application.
  if (!existsSync(directory)) {
    app.useWebSocket(new Cable({ ...options, channels: [] }));
    return [];
  }

  for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: directory, onlyFiles: true })) {
    const module = (await import(Bun.pathToFileURL(join(directory, file)).href)) as Record<
      string,
      unknown
    >;

    for (const exported of Object.values(module)) {
      // A subclass, and not `Channel` itself — an application that re-exports
      // the base class should not have it answering subscriptions.
      if (typeof exported !== "function" || exported === Channel) continue;
      if (!(exported.prototype instanceof Channel)) continue;

      found.push(exported as typeof Channel);
    }
  }

  app.useWebSocket(new Cable({ ...options, channels: found }));

  return found.map((channel) => channel.channelName).sort();
}
