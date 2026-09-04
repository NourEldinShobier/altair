/**
 * Downloads, the client address, and Basic auth.
 *
 * Mirrors actionpack/test/controller/send_file_test.rb, remote_ip_test.rb and
 * http_basic_authentication_test.rb. Almost every test here is about a header
 * carrying something a person supplied, which is where all three of these go
 * wrong.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { clientIp, forwardedFor } from "../src/client-ip.js";
import { contentDisposition, safeFilename, sendData, sendFile, FileNotFound } from "../src/send.js";
import { credentialsMatch, decodeBasic, secretsMatch } from "../src/basic-auth.js";

const get = (headers: Record<string, string> = {}) => new Request("http://test.host/", { headers });

describe("making a filename safe", () => {
  it("leaves an ordinary one alone", () => {
    expect(safeFilename("report.csv")).toBe("report.csv");
  });

  // A newline ends the header, and everything after it is read as a header of
  // its own — which is response splitting.
  it("removes anything that would end the header", () => {
    expect(safeFilename("a\r\nX-Evil: yes")).toBe("aX-Evil: yes");
    expect(safeFilename(`a${String.fromCharCode(0)}b`)).toBe("ab");
  });

  // A quote ends the filename and starts writing parameters.
  it("removes quotes", () => {
    expect(safeFilename('a";x="y')).toBe("a;x=y");
  });

  // A filename is not a path: Rails takes `File.basename` and so does this.
  it("keeps only the last segment of a path", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Windows\\system32")).toBe("system32");
  });

  /**
   * The two spellings of the header have to name the same file. Removing the
   * separators rather than the path left `....etcpasswd`, which has no stem —
   * so the ASCII half substituted `download.etcpasswd` and the RFC 5987 half
   * kept `....etcpasswd`, and which one a browser used depended on its age.
   */
  it("names the same file in both spellings", () => {
    const header = contentDisposition("attachment", "../../etc/passwd");

    expect(header).toBe('attachment; filename="passwd"');
  });

  it("has nothing left to name for a directory", () => {
    expect(safeFilename("a/b/")).toBe("download");
  });

  it("falls back rather than sending nothing", () => {
    expect(safeFilename("   ")).toBe("download");
    expect(safeFilename("..")).toBe("download");
  });
});

describe("the disposition header", () => {
  it("names the file", () => {
    expect(contentDisposition("attachment", "report.csv")).toBe(
      'attachment; filename="report.csv"',
    );
  });

  it("says only the disposition when there is no name", () => {
    expect(contentDisposition("inline", undefined)).toBe("inline");
  });

  // Only the ASCII spelling loses the name to mojibake; only the encoded one
  // loses it entirely on anything old. Both go.
  it("sends both spellings for a name that is not ASCII", () => {
    const header = contentDisposition("attachment", "отчёт.csv");

    expect(header).toContain('filename="');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent("отчёт.csv"));
  });

  it("still gives something readable when nothing survives the stripping", () => {
    expect(contentDisposition("attachment", "отчёт")).toContain('filename="download"');
  });
});

describe("sending data", () => {
  it("carries the bytes and the headers", async () => {
    const response = sendData("id,title\n1,A", { filename: "report.csv", type: "text/csv" });

    expect(await response.text()).toBe("id,title\n1,A");
    expect(response.headers.get("content-type")).toBe("text/csv");
    expect(response.headers.get("content-disposition")).toContain("report.csv");
  });

  it("guesses the type from the name", () => {
    expect(sendData("{}", { filename: "a.json" }).headers.get("content-type")).toContain("json");
  });

  it("can be shown rather than downloaded", () => {
    const response = sendData("<p>hi</p>", { filename: "a.html", disposition: "inline" });

    expect(response.headers.get("content-disposition")).toStartWith("inline;");
  });

  // A proxy that helpfully compresses or transcodes a download corrupts it.
  it("tells anything in the way not to rewrite it", () => {
    expect(sendData("x").headers.get("cache-control")).toContain("no-transform");
  });
});

describe("sending a file", () => {
  it("streams it and names it after the path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "altair-send-"));
    const path = join(directory, "report.csv");
    writeFileSync(path, "id\n1");

    try {
      const response = await sendFile(path);

      expect(await response.text()).toBe("id\n1");
      expect(response.headers.get("content-disposition")).toContain("report.csv");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("says so when there is nothing there", async () => {
    await expect(sendFile(join(tmpdir(), "does-not-exist-9184"))).rejects.toThrow(FileNotFound);
  });
});

// X-Forwarded-For is a list a client can write. Trusting the first entry is
// how a rate limit gets walked around and an audit log gets poisoned.
describe("the client address", () => {
  it("splits the header", () => {
    expect(forwardedFor("1.1.1.1, 2.2.2.2 ,3.3.3.3")).toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
  });

  it("drops a port, including from a bracketed IPv6 address", () => {
    expect(forwardedFor("203.0.113.5:9000, [2001:db8::1]:443")).toEqual([
      "203.0.113.5",
      "2001:db8::1",
    ]);
  });

  it("leaves a bare IPv6 address alone", () => {
    expect(forwardedFor("2001:db8::1")).toEqual(["2001:db8::1"]);
  });

  // An application that has not been told its shape is behind zero proxies.
  it("ignores the header entirely by default", () => {
    const request = get({ "x-forwarded-for": "1.2.3.4" });

    expect(clientIp(request, { socketAddress: "10.0.0.1" })).toBe("10.0.0.1");
  });

  // One load balancer: it saw the client and wrote one entry, so that entry is
  // the client and the socket peer is the balancer.
  it("reads the one entry a single proxy wrote", () => {
    const request = get({ "x-forwarded-for": "1.2.3.4" });

    expect(clientIp(request, { trustedProxies: 1, socketAddress: "10.0.0.1" })).toBe("1.2.3.4");
  });

  // A CDN in front of a balancer: the CDN wrote the client, the balancer
  // appended the CDN. Two of ours, so step back two.
  it("reaches past two", () => {
    const request = get({ "x-forwarded-for": "1.2.3.4, 198.51.100.2" });

    expect(clientIp(request, { trustedProxies: 2, socketAddress: "10.0.0.1" })).toBe("1.2.3.4");
  });

  // The spoof this exists to prevent: a client writing more entries than there
  // are proxies, to push its forgery into the trusted position.
  it("falls back to the socket when the list is shorter than the proxies", () => {
    const request = get({ "x-forwarded-for": "1.2.3.4" });

    expect(clientIp(request, { trustedProxies: 3, socketAddress: "10.0.0.1" })).toBe("10.0.0.1");
  });

  // The spoof: a client sends entries of its own, hoping to be read as one of
  // them. Counting back from the right lands on what our own proxy wrote,
  // whatever the client put in front of it.
  it("ignores entries the client wrote itself", () => {
    const request = get({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.9" });

    expect(clientIp(request, { trustedProxies: 1, socketAddress: "10.0.0.1" })).toBe("203.0.113.9");
  });

  it("still ignores them with two proxies", () => {
    const request = get({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.9, 198.51.100.2" });

    expect(clientIp(request, { trustedProxies: 2, socketAddress: "10.0.0.1" })).toBe("203.0.113.9");
  });

  it("falls back with no header at all", () => {
    expect(clientIp(get(), { trustedProxies: 1, socketAddress: "10.0.0.1" })).toBe("10.0.0.1");
  });
});

describe("basic authentication", () => {
  const header = (name: string, password: string) =>
    `Basic ${Buffer.from(`${name}:${password}`).toString("base64")}`;

  it("reads the credentials", () => {
    expect(decodeBasic(header("ada", "hunter2"))).toEqual({ name: "ada", password: "hunter2" });
  });

  // A password may contain a colon; a username may not. Splitting on the last
  // one lets someone with a colon in their password log in as another account.
  it("splits on the first colon", () => {
    expect(decodeBasic(header("ada", "a:b:c"))).toEqual({ name: "ada", password: "a:b:c" });
  });

  it("reads a non-ASCII password", () => {
    expect(decodeBasic(header("ada", "pässwörd"))?.password).toBe("pässwörd");
  });

  it("gives nothing for a header it cannot use", () => {
    expect(decodeBasic(null)).toBeUndefined();
    expect(decodeBasic("Bearer abc")).toBeUndefined();
    expect(decodeBasic("Basic")).toBeUndefined();
    expect(decodeBasic(`Basic ${Buffer.from("nocolon").toString("base64")}`)).toBeUndefined();
  });

  // `===` returns as soon as two bytes differ, so the time it takes says how
  // much of the guess was right.
  it("compares without leaking how far it matched", () => {
    expect(secretsMatch("hunter2", "hunter2")).toBe(true);
    expect(secretsMatch("hunter3", "hunter2")).toBe(false);
    expect(secretsMatch("", "hunter2")).toBe(false);
  });

  it("compares secrets of different lengths without throwing", () => {
    expect(secretsMatch("a", "a much longer secret")).toBe(false);
  });

  it("checks both halves", () => {
    const expected = { name: "admin", password: "s3cret" };

    expect(credentialsMatch({ name: "admin", password: "s3cret" }, expected)).toBe(true);
    expect(credentialsMatch({ name: "admin", password: "wrong" }, expected)).toBe(false);
    expect(credentialsMatch({ name: "nobody", password: "s3cret" }, expected)).toBe(false);
  });
});

describe("from a controller", () => {
  class ReportsController extends Controller {
    index(): void {
      if (
        !this.authenticateOrRequest((name, password) => name === "admin" && password === "s3cret")
      )
        return;

      this.send("id,title\n1,A", { filename: "report.csv", type: "text/csv" });
    }
  }

  const run = async (headers: Record<string, string> = {}) =>
    await new ReportsController({ request: get(headers), session: {} }).processAction("index");

  it("asks for credentials when there are none", async () => {
    const response = await run();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('realm="Application"');
  });

  it("refuses the wrong ones", async () => {
    const wrong = `Basic ${Buffer.from("admin:guess").toString("base64")}`;

    expect((await run({ authorization: wrong })).status).toBe(401);
  });

  it("sends the file to the right ones", async () => {
    const right = `Basic ${Buffer.from("admin:s3cret").toString("base64")}`;
    const response = await run({ authorization: right });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("1,A");
  });

  it("never lets a 401 be cached", async () => {
    expect((await run()).headers.get("cache-control")).toBe("no-store");
  });
});
