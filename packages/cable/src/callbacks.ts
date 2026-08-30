/**
 * Hooks around a channel's lifecycle, ported from
 * `ActionCable::Channel::Callbacks`.
 *
 *     onBeforeSubscribe(ChatChannel, (channel) => audit(channel))
 *
 * The same argument as controller filters: the work that has to happen around
 * every subscription — auditing who joined, marking a user present, timing an
 * action — does not belong copied into each `subscribed`, because the copy
 * that gets forgotten is the one nobody notices is missing.
 *
 * Registered per channel class rather than by subclassing, so an application
 * can add a hook to a channel it did not write.
 */

import type { Channel } from "./channel.js";

/** What a lifecycle hook is given. */
export type ChannelHook = (channel: Channel) => void | Promise<void>;

/** What an action hook is given, so it can see which action ran. */
export type ActionHook = (channel: Channel, action: string) => void | Promise<void>;

interface Hooks {
  beforeSubscribe: ChannelHook[];
  afterSubscribe: ChannelHook[];
  beforeUnsubscribe: ChannelHook[];
  afterUnsubscribe: ChannelHook[];
  beforeAction: ActionHook[];
  afterAction: ActionHook[];
}

const registry = new Map<string, Hooks>();

function hooksFor(channelClass: { name: string }): Hooks {
  const existing = registry.get(channelClass.name);
  if (existing) return existing;

  const fresh: Hooks = {
    beforeSubscribe: [],
    afterSubscribe: [],
    beforeUnsubscribe: [],
    afterUnsubscribe: [],
    beforeAction: [],
    afterAction: [],
  };

  registry.set(channelClass.name, fresh);

  return fresh;
}

/** Rails' `before_subscribe`. */
export function onBeforeSubscribe(channelClass: { name: string }, hook: ChannelHook): void {
  hooksFor(channelClass).beforeSubscribe.push(hook);
}

/**
 * Rails' `after_subscribe`.
 *
 * Runs whether or not the subscription was rejected, which is Rails'
 * behaviour and the useful one: "somebody tried to join a room they cannot
 * see" is exactly what an audit hook wants to record, and a hook that only ran
 * on success would never see it.
 */
export function onAfterSubscribe(channelClass: { name: string }, hook: ChannelHook): void {
  hooksFor(channelClass).afterSubscribe.push(hook);
}

/** Rails' `before_unsubscribe`. */
export function onBeforeUnsubscribe(channelClass: { name: string }, hook: ChannelHook): void {
  hooksFor(channelClass).beforeUnsubscribe.push(hook);
}

/** Rails' `after_unsubscribe`. */
export function onAfterUnsubscribe(channelClass: { name: string }, hook: ChannelHook): void {
  hooksFor(channelClass).afterUnsubscribe.push(hook);
}

/** Rails' `before_action` on a channel. */
export function onBeforeAction(channelClass: { name: string }, hook: ActionHook): void {
  hooksFor(channelClass).beforeAction.push(hook);
}

/** Rails' `after_action` on a channel. */
export function onAfterAction(channelClass: { name: string }, hook: ActionHook): void {
  hooksFor(channelClass).afterAction.push(hook);
}

/** Every hook registered for a channel, for introspection and for tests. */
export function channelHooks(channelClass: { name: string }): Readonly<Hooks> {
  return hooksFor(channelClass);
}

/** Forgets every registration. For tests that declare their own. */
export function resetChannelHooks(): void {
  registry.clear();
}

/**
 * Runs a channel's subscribe with its hooks around it.
 *
 * The after hooks run in a finally, so a `subscribed` that threw still lets an
 * audit hook record the attempt — a failed subscription is the one most worth
 * knowing about.
 */
export async function runSubscribe(channel: Channel): Promise<void> {
  const hooks = hooksFor(channel.constructor as { name: string });

  for (const hook of hooks.beforeSubscribe) await hook(channel);

  try {
    await channel.subscribed();
  } finally {
    for (const hook of hooks.afterSubscribe) await hook(channel);
  }
}

/** The same around unsubscribe. */
export async function runUnsubscribe(channel: Channel): Promise<void> {
  const hooks = hooksFor(channel.constructor as { name: string });

  for (const hook of hooks.beforeUnsubscribe) await hook(channel);

  try {
    await channel.unsubscribed();
  } finally {
    for (const hook of hooks.afterUnsubscribe) await hook(channel);
  }
}

/**
 * Runs an action with its hooks around it. Rails' `perform_action`.
 *
 * The action name is given to the hooks, because a timing or authorisation
 * hook that could not tell which action it was wrapping would have to be
 * registered once per action to be useful.
 */
export async function performAction(
  channel: Channel,
  action: string,
  data: Record<string, unknown>,
): Promise<void> {
  const hooks = hooksFor(channel.constructor as { name: string });

  for (const hook of hooks.beforeAction) await hook(channel, action);

  try {
    await channel.dispatch({ action, ...data });
  } finally {
    for (const hook of hooks.afterAction) await hook(channel, action);
  }
}
