/**
 * Permissions Policy, ported from `ActionDispatch::PermissionsPolicy`.
 *
 * Says which browser features a page may use, and — the part that earns it —
 * which of them the frames it embeds may use. A page with no policy can be
 * asked for the camera by any third-party frame it loads, and the prompt says
 * the top-level site's name.
 *
 *     const policy = new PermissionsPolicy()
 *       .camera("none")
 *       .geolocation("self")
 *       .fullscreen("self", "https://player.example.com")
 *
 *     app.middleware.use("permissions", permissionsPolicy(policy))
 *
 * Written by hand the syntax is easy to get wrong in a way that fails open:
 * `camera=()` forbids it and `camera=*` allows it everywhere, and the
 * difference is two characters. This builds the string.
 */

import type { Middleware } from "./middleware.js";

/** Where a feature may be used. */
export type PermissionSource = "self" | "none" | "*" | (string & {});

/** `pictureInPicture` is `picture-in-picture` in the header. */
function headerName(feature: string): string {
  return feature.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * One source, in the syntax the header wants.
 *
 * `self` is a bare keyword here and `'self'` in a Content Security Policy —
 * two headers describing similar things in different spellings, which is
 * exactly the kind of detail worth writing once.
 */
function formatSource(source: string): string {
  if (source === "none") return "";
  if (source === "self" || source === "*") return source;

  return `"${source}"`;
}

export class PermissionsPolicy {
  readonly directives = new Map<string, string[]>();

  /**
   * Names a feature that has no method of its own.
   *
   * Browsers add these faster than a framework can, and a directive a browser
   * does not know is ignored rather than treated as an error — so naming one
   * directly is safe, and the named methods are only a convenience.
   */
  allow(feature: string, ...sources: PermissionSource[]): this {
    this.directives.set(headerName(feature), sources.length > 0 ? [...sources] : ["none"]);
    return this;
  }

  /** Rails' `policy.accelerometer`. */
  accelerometer(...sources: PermissionSource[]): this {
    return this.allow("accelerometer", ...sources);
  }

  /** Rails' `policy.ambientLightSensor`. */
  ambientLightSensor(...sources: PermissionSource[]): this {
    return this.allow("ambientLightSensor", ...sources);
  }

  /** Rails' `policy.autoplay`. */
  autoplay(...sources: PermissionSource[]): this {
    return this.allow("autoplay", ...sources);
  }

  /** Rails' `policy.camera`. */
  camera(...sources: PermissionSource[]): this {
    return this.allow("camera", ...sources);
  }

  /** Rails' `policy.encryptedMedia`. */
  encryptedMedia(...sources: PermissionSource[]): this {
    return this.allow("encryptedMedia", ...sources);
  }

  /** Rails' `policy.fullscreen`. */
  fullscreen(...sources: PermissionSource[]): this {
    return this.allow("fullscreen", ...sources);
  }

  /** Rails' `policy.geolocation`. */
  geolocation(...sources: PermissionSource[]): this {
    return this.allow("geolocation", ...sources);
  }

  /** Rails' `policy.gyroscope`. */
  gyroscope(...sources: PermissionSource[]): this {
    return this.allow("gyroscope", ...sources);
  }

  /** Rails' `policy.magnetometer`. */
  magnetometer(...sources: PermissionSource[]): this {
    return this.allow("magnetometer", ...sources);
  }

  /** Rails' `policy.microphone`. */
  microphone(...sources: PermissionSource[]): this {
    return this.allow("microphone", ...sources);
  }

  /** Rails' `policy.midi`. */
  midi(...sources: PermissionSource[]): this {
    return this.allow("midi", ...sources);
  }

  /** Rails' `policy.payment`. */
  payment(...sources: PermissionSource[]): this {
    return this.allow("payment", ...sources);
  }

  /** Rails' `policy.pictureInPicture`. */
  pictureInPicture(...sources: PermissionSource[]): this {
    return this.allow("pictureInPicture", ...sources);
  }

  /** Rails' `policy.usb`. */
  usb(...sources: PermissionSource[]): this {
    return this.allow("usb", ...sources);
  }

  /** Rails' `policy.vibrate`. */
  vibrate(...sources: PermissionSource[]): this {
    return this.allow("vibrate", ...sources);
  }

  /** Rails' `policy.vr`. */
  vr(...sources: PermissionSource[]): this {
    return this.allow("vr", ...sources);
  }

  /** The header value, or an empty string when nothing was said. */
  toString(): string {
    return [...this.directives]
      .map(([feature, sources]) => {
        // `camera=()` forbids it. An empty list is the point, not an omission.
        if (sources.length === 1 && sources[0] === "none") return `${feature}=()`;

        return `${feature}=(${sources.map((source) => formatSource(source)).join(" ")})`;
      })
      .join(", ");
  }
}

/**
 * Sets the header on every response.
 *
 * Nothing is sent when the policy says nothing: an empty `Permissions-Policy`
 * is not the same as no policy, and a header that means "no opinion" is worth
 * leaving off rather than guessing at.
 */
export function permissionsPolicy(policy: PermissionsPolicy): Middleware {
  const value = policy.toString();

  return async (request, next) => {
    const response = await next(request);

    if (value === "") return response;

    // Rebuilt because a response's headers are immutable once constructed.
    const headers = new Headers(response.headers);
    headers.set("permissions-policy", value);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
