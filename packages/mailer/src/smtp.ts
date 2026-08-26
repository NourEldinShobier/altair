/**
 * Sending mail over SMTP, the equivalent of Rails' `:smtp` delivery method.
 *
 * Until this existed the framework could compose a message, render it, check
 * its headers and hand it to a test double — and an application built on it
 * could not send an email. The interface was already shaped like Nodemailer's
 * `sendMail`, so the wiring was one line somebody had to know to write. Nobody
 * was told, and nothing proved a message ever crossed a socket.
 *
 *     Mailer.delivery = smtpDelivery({
 *       host: "smtp.example.com",
 *       port: 587,
 *       auth: { user, pass },
 *     })
 *
 * Nodemailer rather than a hand-rolled client, and not a close call: SMTP is
 * STARTTLS negotiation, four authentication mechanisms, MIME encoding,
 * connection pooling and two decades of server quirks. Rails leans on the
 * `mail` gem for exactly the same reason.
 */

import { createTransport, type Transporter } from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool/index.js";
import type { DeliveryMethod, MessageFields } from "./message.js";

export interface SmtpOptions {
  host: string;
  /** 587 for STARTTLS, 465 for implicit TLS. Defaults to 587. */
  port?: number;
  /**
   * Whether the connection is TLS from the first byte.
   *
   * Defaults to true only on 465, which is the port that means it. On 587 the
   * connection starts in plaintext and upgrades, which is what `requireTls`
   * below insists actually happens.
   */
  secure?: boolean;
  auth?: { user: string; pass: string };
  /**
   * Refuses to send at all if the server will not upgrade to TLS.
   *
   * On by default, and the reason is the failure it prevents: without it
   * Nodemailer sends in the clear when STARTTLS is unavailable, so a
   * misconfigured server turns every password reset into plaintext on the
   * wire and nothing anywhere says so.
   */
  requireTls?: boolean;
  /** Seconds to wait for the connection. */
  connectionTimeout?: number;
  /** Keeps connections open between messages, for a worker sending in bulk. */
  pool?: boolean;
  /**
   * Accepts a certificate that does not verify.
   *
   * For a development server with a self-signed certificate, and named so that
   * turning it on is a decision rather than a shrug.
   */
  allowSelfSigned?: boolean;
}

/**
 * A delivery method that talks to a real server.
 *
 * The transporter is built once and reused, which is what makes `pool` worth
 * anything — a new connection per message is a TLS handshake per message.
 */
export function smtpDelivery(options: SmtpOptions): DeliveryMethod & { close(): void } {
  const port = options.port ?? 587;

  const settings = {
    host: options.host,
    port,
    // 465 is the port that means TLS from the first byte; everything else
    // starts in plaintext and upgrades.
    secure: options.secure ?? port === 465,
    requireTLS: options.requireTls ?? true,
    auth: options.auth,
    connectionTimeout: (options.connectionTimeout ?? 30) * 1000,
    ...(options.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
  };

  // Two calls rather than a `pool` key that is sometimes undefined: pooling
  // picks a different transport in Nodemailer, and its options type says so by
  // requiring the literal `true`.
  const transporter: Transporter = options.pool
    ? createTransport({ ...settings, pool: true } satisfies SMTPPool.Options)
    : createTransport(settings);

  return {
    async sendMail(message: MessageFields): Promise<unknown> {
      return await transporter.sendMail(message as Parameters<Transporter["sendMail"]>[0]);
    },

    /** Closes any pooled connections. A worker should call this on shutdown. */
    close(): void {
      transporter.close();
    },
  };
}

/**
 * Reads the same environment Rails' `SMTP_URL` convention uses.
 *
 *     smtp://user:password@smtp.example.com:587
 *
 * Here so an application deploys by setting one variable rather than editing
 * an initializer per environment.
 */
export function smtpDeliveryFromUrl(
  url: string,
  extra: Partial<SmtpOptions> = {},
): DeliveryMethod & { close(): void } {
  const parsed = new URL(url);

  return smtpDelivery({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    // `smtps://` is the implicit-TLS spelling.
    secure: parsed.protocol === "smtps:" ? true : undefined,
    auth: parsed.username
      ? { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) }
      : undefined,
    ...extra,
  });
}
