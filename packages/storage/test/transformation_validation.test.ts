/**
 * Checking a transformation before doing the work, ported from the
 * `validate_transformation` cases in
 * `activestorage/test/models/variant_test.rb`.
 *
 * Every value here is one the type system cannot bound. `resize` is a pair of
 * numbers and `[0, 0]` typechecks; `rotate` is documented as a multiple of 90
 * and 37 typechecks; `quality` is documented as 1-100 and 5000 typechecks.
 * Unchecked, each fails somewhere further in with a message about the decoder
 * rather than about the number — and one of them does not fail at all.
 */

import { describe, expect, it } from "bun:test";
import {
  InvalidTransformation,
  MAXIMUM_VARIANT_DIMENSION,
  validateTransformation,
} from "../src/variant.js";

describe("resize", () => {
  it("takes an ordinary size", () => {
    expect(() => {
      validateTransformation({ resize: [400, 300] });
    }).not.toThrow();
  });

  it("takes one dimension", () => {
    expect(() => {
      validateTransformation({ resize: [400] });
    }).not.toThrow();
  });

  /**
   * The one that does not fail on its own. The cost of a resize is the product
   * of the target dimensions and nothing else bounds it, so a route that lets
   * any part of a transformation come from a parameter is a denial of service
   * needing no exploit beyond a large number.
   */
  it("refuses a size that would exhaust the machine", () => {
    expect(() => {
      validateTransformation({ resize: [50_000, 50_000] });
    }).toThrow(InvalidTransformation);
  });

  it("names the limit, so the message is actionable", () => {
    expect(() => {
      validateTransformation({ resize: [50_000, 50_000] });
    }).toThrow(String(MAXIMUM_VARIANT_DIMENSION));
  });

  it("takes the limit itself", () => {
    expect(() => {
      validateTransformation({ resize: [MAXIMUM_VARIANT_DIMENSION, 1] });
    }).not.toThrow();
  });

  it("refuses one pixel over", () => {
    expect(() => {
      validateTransformation({ resize: [MAXIMUM_VARIANT_DIMENSION + 1, 1] });
    }).toThrow(InvalidTransformation);
  });

  it("checks the second dimension too", () => {
    expect(() => {
      validateTransformation({ resize: [10, 50_000] });
    }).toThrow(InvalidTransformation);
  });

  it("refuses zero and negative sizes", () => {
    expect(() => {
      validateTransformation({ resize: [0, 100] });
    }).toThrow(InvalidTransformation);
    expect(() => {
      validateTransformation({ resize: [-100, 100] });
    }).toThrow(InvalidTransformation);
  });

  it("refuses a fractional size", () => {
    expect(() => {
      validateTransformation({ resize: [100.5, 100] });
    }).toThrow(InvalidTransformation);
  });

  it("refuses a size that is not a number", () => {
    expect(() => {
      validateTransformation({ resize: [Number.NaN, 100] });
    }).toThrow(InvalidTransformation);
  });
});

describe("rotate", () => {
  it("takes the multiples of 90", () => {
    for (const angle of [0, 90, 180, 270, 360, -90]) {
      expect(() => {
        validateTransformation({ rotate: angle });
      }).not.toThrow();
    }
  });

  /** Anything else needs interpolation and a colour for the corners. */
  it("refuses anything else", () => {
    expect(() => {
      validateTransformation({ rotate: 37 });
    }).toThrow("multiple of 90");
    expect(() => {
      validateTransformation({ rotate: 45 });
    }).toThrow(InvalidTransformation);
  });

  it("refuses a fractional angle", () => {
    expect(() => {
      validateTransformation({ rotate: 90.5 });
    }).toThrow(InvalidTransformation);
  });
});

describe("quality", () => {
  it("takes 1 to 100", () => {
    for (const quality of [1, 50, 100]) {
      expect(() => {
        validateTransformation({ quality });
      }).not.toThrow();
    }
  });

  it("refuses what is outside it", () => {
    expect(() => {
      validateTransformation({ quality: 0 });
    }).toThrow(InvalidTransformation);
    expect(() => {
      validateTransformation({ quality: 5000 });
    }).toThrow(InvalidTransformation);
    expect(() => {
      validateTransformation({ quality: -1 });
    }).toThrow(InvalidTransformation);
  });

  it("refuses a fractional quality", () => {
    expect(() => {
      validateTransformation({ quality: 50.5 });
    }).toThrow(InvalidTransformation);
  });
});

describe("brightness and saturation", () => {
  it("takes a non-negative multiplier", () => {
    expect(() => {
      validateTransformation({ brightness: 1.2, saturation: 0.8 });
    }).not.toThrow();
    expect(() => {
      validateTransformation({ brightness: 0 });
    }).not.toThrow();
  });

  it("refuses a negative one", () => {
    expect(() => {
      validateTransformation({ brightness: -1 });
    }).toThrow("brightness");
    expect(() => {
      validateTransformation({ saturation: -1 });
    }).toThrow("saturation");
  });

  it("refuses infinity", () => {
    expect(() => {
      validateTransformation({ saturation: Number.POSITIVE_INFINITY });
    }).toThrow(InvalidTransformation);
  });
});

describe("nothing to check", () => {
  it("takes an empty transformation", () => {
    expect(() => {
      validateTransformation({});
    }).not.toThrow();
  });

  it("takes the options it has no numbers for", () => {
    expect(() => {
      validateTransformation({ format: "webp", flip: true, fit: "cover" });
    }).not.toThrow();
  });
});
