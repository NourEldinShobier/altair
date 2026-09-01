/**
 * Uploaded files and parameter encoding, ported from
 * `actionpack/test/dispatch/uploaded_file_test.rb`,
 * `actionpack/test/dispatch/multipart_params_parsing_test.rb` and the encoding
 * cases in `actionpack/test/dispatch/request/query_string_parsing_test.rb`.
 *
 * A filename that arrives with an upload is chosen by the person uploading and
 * usually ends up naming a file on disk, so most of these are about that one
 * value.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { contentDisposition, safeFilename } from "../src/send.js";
import {
  actionEncodingTemplate,
  asciiFilename,
  basename,
  convertedArrays,
  deconstructKeys,
  encodeParams,
  extractValue,
  formData,
  hasValue,
  normalizeEncodeParams,
  paramsArrayFrom,
  paramsValid,
  rawParams,
  resetParamEncodings,
  setupParamEncode,
  shouldMultipart,
  storedFilename,
  toIo,
  uploadedFile,
  utf8Filename,
} from "../src/multipart.js";

afterEach(() => {
  resetParamEncodings();
});

describe("a filename off the wire", () => {
  /**
   * The sender's filesystem is not the receiver's: a Windows client sends
   * `C:\Users\ada\photo.png`, and a server splitting on `/` alone keeps the
   * whole thing as one "filename".
   */
  it("takes the last segment whatever the separator", () => {
    expect(basename("photo.png")).toBe("photo.png");
    expect(basename("/tmp/photo.png")).toBe("photo.png");
    expect(basename("C:\\Users\\ada\\photo.png")).toBe("photo.png");
  });

  /** A browser sends `foo.png` and an attacker sends a traversal, in one field. */
  it("keeps no path at all in what is written to disk", () => {
    expect(safeFilename("../../etc/passwd")).not.toContain("/");
    expect(safeFilename("../../etc/passwd")).not.toContain("..\\");
  });

  /**
   * Dropping the non-ASCII characters turns `résumé.pdf` into `rsum.pdf`,
   * which is a name nobody recognises — and the extension is the part the
   * receiving system acts on.
   */
  it("transliterates rather than truncating", () => {
    expect(asciiFilename("résumé.pdf")).toBe("resume.pdf");
  });

  /**
   * A row of underscores is not a name, and a browser's save dialog is where
   * it would be read — but the extension is what the receiving system acts on,
   * so it survives.
   */
  it("falls back to a real word when nothing transliterates", () => {
    expect(asciiFilename("日本語.pdf")).toBe("download.pdf");
    expect(asciiFilename("отчёт")).toBe("download");
  });

  /** A name with any Latin in it keeps that, rather than falling back. */
  it("does not fall back when some of the name survives", () => {
    expect(asciiFilename("報告-v2.pdf")).toBe("__-v2.pdf");
  });

  /** A quote would end the parameter and let the rest be read as another. */
  it("keeps a quote out of the header parameter", () => {
    expect(asciiFilename('we"ird.pdf')).not.toContain('"');
  });

  /**
   * Percent-encoded with the charset named, which is what lets a client show
   * the real name.
   */
  it("writes the RFC 5987 form", () => {
    expect(utf8Filename("résumé.pdf")).toBe("UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it("escapes a quote in the encoded form too", () => {
    expect(utf8Filename("a'b.pdf")).toContain("%27");
  });

  /**
   * A client that does not understand `filename*` uses `filename`, and one
   * that does ignores it — so both go out, and only when they differ.
   */
  it("sends both spellings for a non-ASCII name", () => {
    const header = contentDisposition("attachment", "résumé.pdf");

    expect(header).toContain('filename="resume.pdf"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it("sends one spelling for a plain name", () => {
    expect(contentDisposition("attachment", "photo.png")).toBe('attachment; filename="photo.png"');
  });
});

describe("an uploaded file", () => {
  const file = uploadedFile("../photo.png", new Uint8Array([1, 2, 3]), "image/png");

  /**
   * The declared type is a claim by the uploader, kept because most upload
   * handling is about the claim — including when it disagrees with the bytes.
   */
  it("keeps the declared type and the original name", () => {
    expect(file.contentType).toBe("image/png");
    expect(file.originalFilename).toBe("../photo.png");
  });

  it("defaults to bytes when nothing was declared", () => {
    expect(uploadedFile("x", new Uint8Array()).contentType).toBe("application/octet-stream");
  });

  it("derives a safe name for disk", () => {
    expect(storedFilename(file)).not.toContain("/");
  });

  /**
   * One shared reader means a second consumer — a scanner, a checksum, a
   * thumbnailer — finds it at the end and reads zero bytes, which looks
   * exactly like an empty upload.
   */
  it("hands out a fresh view each time", () => {
    const first = toIo(file);
    first[0] = 99;

    expect(toIo(file)[0]).toBe(1);
    expect(toIo(file)).not.toBe(first);
  });
});

describe("deciding how to encode a request", () => {
  /**
   * A form posted as urlencoded with a file in it sends the file's inspect
   * output as a string — the request succeeds, the record saves, and the
   * attachment is that text.
   */
  it("notices a file at any depth", () => {
    const file = uploadedFile("a.png", new Uint8Array([1]));

    expect(shouldMultipart({ post: { title: "a" } })).toBe(false);
    expect(shouldMultipart({ post: { cover: file } })).toBe(true);
    expect(shouldMultipart({ post: { covers: [file] } })).toBe(true);
    expect(shouldMultipart({ blob: new Uint8Array([1]) })).toBe(true);
  });

  /**
   * `post.tags` produces a request the server accepts and parses into one flat
   * parameter with a dot in its name.
   */
  it("writes nested keys in bracket form", () => {
    expect(formData({ post: { title: "a" } })).toEqual([["post[title]", "a"]]);
  });

  /**
   * Without the trailing brackets a repeated parameter parses as a single
   * value — the last one — rather than as a list.
   */
  it("marks a list with trailing brackets", () => {
    expect(formData({ post: { tags: ["a", "b"] } })).toEqual([
      ["post[tags][]", "a"],
      ["post[tags][]", "b"],
    ]);
  });

  it("passes a file through rather than descending into it", () => {
    const file = uploadedFile("a.png", new Uint8Array([1]));

    expect(formData({ cover: file })).toEqual([["cover", file]]);
  });

  it("keeps an explicit null", () => {
    expect(formData({ a: null })).toEqual([["a", null]]);
  });
});

describe("parameter encoding", () => {
  /**
   * Per action *and* parameter: doing it per action would turn every other
   * parameter into bytes too, and those are compared against strings
   * everywhere.
   */
  it("is declared per parameter", () => {
    setupParamEncode("uploads", "create", "blob", "binary");
    setupParamEncode("uploads", "create", "name", "UTF-8");

    expect(actionEncodingTemplate("uploads", "create")).toEqual({
      blob: "binary",
      name: "UTF-8",
    });
  });

  it("keeps actions apart", () => {
    setupParamEncode("uploads", "create", "blob", "binary");

    expect(actionEncodingTemplate("uploads", "update")).toEqual({});
  });

  /**
   * A parameter with no declared encoding stays a string, because decoding
   * everything as bytes moves the decision to every reader instead of the one
   * declaration.
   */
  it("leaves undeclared parameters as text", () => {
    setupParamEncode("uploads", "create", "blob", "binary");
    const encoded = normalizeEncodeParams(
      { blob: "\u00FF\u00FE", name: "photo" },
      actionEncodingTemplate("uploads", "create"),
    );

    expect(encoded["name"]).toBe("photo");
    expect(encoded["blob"]).toBeInstanceOf(Uint8Array);
  });

  it("reads each character as one byte", () => {
    expect(encodeParams("\u00FF\u0000", "binary")).toEqual(new Uint8Array([0xff, 0]));
  });

  it("leaves UTF-8 as a string", () => {
    expect(encodeParams("résumé", "UTF-8")).toBe("résumé");
  });

  /**
   * Converting to an encoding the runtime cannot represent produces a string
   * that compares unequal to itself once it makes a round trip.
   */
  it("refuses an encoding it cannot represent", () => {
    expect(() => encodeParams("a", "ISO-8859-1")).toThrow("round trip");
  });
});

describe("reading parameters back", () => {
  /**
   * Returning a bare value for one and a list for two makes every consumer
   * branch on the count, and the branch is always missing for the
   * one-element case — which is what a single ticked box produces.
   */
  it("always gives a list", () => {
    expect(paramsArrayFrom("a")).toEqual(["a"]);
    expect(paramsArrayFrom(["a", "b"])).toEqual(["a", "b"]);
    expect(paramsArrayFrom(undefined)).toEqual([]);
  });

  /**
   * Converting on each read means two reads of one nested parameter produce
   * two different objects, so a caller that assigned to the first sees nothing
   * on the second.
   */
  it("converts once", () => {
    const cache = new WeakMap<object, unknown[]>();
    const source = {};
    let conversions = 0;
    const convert = () => {
      conversions += 1;

      return [1];
    };

    const first = convertedArrays(cache, source, convert);

    expect(convertedArrays(cache, source, convert)).toBe(first);
    expect(conversions).toBe(1);
  });

  /**
   * A caller inspecting the raw form must not be able to edit what the request
   * is processed with — the two would then disagree and only one is logged.
   */
  it("hands back a copy of the raw parameters", () => {
    const params = { a: 1 };
    const raw = rawParams(params);
    raw["a"] = 2;

    expect(params.a).toBe(1);
  });

  /**
   * An invalid byte sequence is a malformed request, not an exception in
   * whichever model first touches it — reporting it from the model sends the
   * reader to a validation that is fine.
   */
  it("notices a parameter that did not decode", () => {
    expect(paramsValid({ a: "ok" })).toBe(true);
    expect(paramsValid({ a: "🎉" })).toBe(true);
    expect(paramsValid({ a: `bad${String.fromCharCode(0xd800)}` })).toBe(false);
  });

  /**
   * An empty string is what an untouched text field sends: present, and not a
   * value. Treating it as one is how a blank field overwrites a real value.
   */
  it("tells present from having a value", () => {
    expect(hasValue({ a: "x" }, "a")).toBe(true);
    expect(hasValue({ a: "" }, "a")).toBe(false);
    expect(hasValue({ a: null }, "a")).toBe(false);
    expect(hasValue({}, "a")).toBe(false);
    expect(hasValue({ a: [] }, "a")).toBe(false);
  });

  it("counts zero and false as values", () => {
    expect(hasValue({ a: 0 }, "a")).toBe(true);
    expect(hasValue({ a: false }, "a")).toBe(true);
  });

  it("reads a nested path", () => {
    const params = { post: { author: { name: "Ada" } } };

    expect(extractValue(params, "post[author][name]")).toBe("Ada");
    expect(extractValue(params, "post[absent][name]")).toBeUndefined();
    expect(extractValue(params, "post")).toEqual({ author: { name: "Ada" } });
  });

  /**
   * An entry for a missing key would make a pattern match succeed with
   * nothing, which is the one thing a pattern match is supposed to prevent.
   */
  it("gives no entry for a key that is not there", () => {
    // By key rather than by value: an entry whose value is `undefined` compares
    // equal to no entry at all, which is exactly the confusion being prevented.
    expect(Object.keys(deconstructKeys({ a: 1 }, ["a", "b"]))).toEqual(["a"]);
  });

  it("gives everything when no keys were named", () => {
    expect(deconstructKeys({ a: 1, b: 2 }, undefined)).toEqual({ a: 1, b: 2 });
  });
});
