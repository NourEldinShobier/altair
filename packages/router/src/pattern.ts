/**
 * The route-pattern language, ported from `ActionDispatch::Journey` — the
 * scanner, the parser, the node types and the regexp each pattern compiles to.
 *
 * `route.ts` splits a pattern on slashes, which is enough for `/posts/:id` and
 * nothing else. A Rails route is a small language: `(.:format)` is an optional
 * group, `*path` is a greedy wildcard, `|` is an alternation, and a segment can
 * carry its own constraint. Splitting on `/` cannot see any of that — an
 * optional group is invisible to it, so `/posts/:id(.:format)` becomes a route
 * with a literal segment named `:id(.` — so the whole grammar needs parsing
 * rather than splitting.
 *
 * Compiling to one regexp rather than matching segment by segment is what makes
 * this worth doing: a router matches every route in the table against every
 * request, so the per-request work is the thing to keep small, and the parse
 * happens once at boot.
 *
 * The pattern is developer-supplied, not user-supplied — it comes from the
 * routes file — but the *path* it matches is not, so the regexp it builds has
 * to be anchored and every literal in it escaped. An unescaped `.` in a literal
 * segment is a wildcard, and a route for `/robots.txt` that also matches
 * `/robotsXtxt` is the kind of thing nobody notices until it routes something
 * it should not.
 */

/** What the scanner found. Rails' `STATIC_TOKENS` plus `LITERAL`. */
export type Token = "DOT" | "SLASH" | "LPAREN" | "RPAREN" | "OR" | "SYMBOL" | "STAR" | "LITERAL";

const STATIC_TOKENS: Record<string, Token> = {
  ".": "DOT",
  "/": "SLASH",
  "(": "LPAREN",
  ")": "RPAREN",
  "|": "OR",
  ":": "SYMBOL",
  "*": "STAR",
};

/** Characters a literal segment may contain unescaped. Rails' literal scan. */
const LITERAL_CHARS = /[\w%\-~!$&'*+,;=@]/;

/**
 * Walks a pattern one token at a time. Rails' `Journey::Scanner`.
 *
 * A hand-written scanner rather than one regexp over the whole pattern,
 * because `:` and `*` are only tokens when a name follows them: `/a:b` names a
 * parameter, but `/a::b` does not, and a single regexp cannot make that call
 * without lookahead that gets steadily less readable than this.
 */
export class Scanner {
  #input = "";
  #pos = 0;
  #length = 0;

  /** Rails' `scan_setup`. */
  scanSetup(input: string): void {
    this.#input = input;
    this.#pos = 0;
    this.#length = 0;
  }

  /** Rails' `peek_byte`. */
  peekByte(): string | undefined {
    return this.#input[this.#pos];
  }

  get eos(): boolean {
    return this.#pos >= this.#input.length;
  }

  /** Rails' `next_token`. */
  nextToken(): Token | undefined {
    if (this.eos) return undefined;

    const next = this.peekByte() as string;
    const staticToken = STATIC_TOKENS[next];

    if (staticToken && (staticToken !== "SYMBOL" || this.#nameFollows())) {
      this.#pos += 1;

      // `:id` and `*path` carry their name with them, so the token's text is
      // the sigil plus everything word-shaped after it.
      if (staticToken === "SYMBOL" || staticToken === "STAR") {
        const start = this.#pos;

        while (!this.eos && /\w/.test(this.#input[this.#pos] as string)) this.#pos += 1;

        this.#length = this.#pos - start + 1;
      } else {
        this.#length = 1;
      }

      return staticToken;
    }

    const start = this.#pos;

    while (!this.eos) {
      const char = this.#input[this.#pos] as string;

      if (char === "\\" && this.#input[this.#pos + 1] !== undefined) {
        this.#pos += 2;
        continue;
      }

      if (!LITERAL_CHARS.test(char)) break;

      this.#pos += 1;
    }

    // A character that is neither a token nor literal-shaped is still one
    // character of literal: refusing it would make a pattern with an unusual
    // byte in it a boot-time crash rather than a route that matches that byte.
    if (this.#pos === start) this.#pos += 1;

    this.#length = this.#pos - start;

    return "LITERAL";
  }

  /** The text of the token just read. Rails' `last_string`. */
  lastString(): string {
    return this.#input.slice(this.#pos - this.#length, this.#pos);
  }

  /**
   * The same, with escapes removed. Rails' `last_literal`.
   *
   * `\(` in a pattern is a literal parenthesis rather than the start of an
   * optional group, and by the time it reaches the regexp builder the
   * backslash has done its job here and would otherwise be escaped again.
   */
  lastLiteral(): string {
    return this.lastString().replace(/\\/g, "");
  }

  #nameFollows(): boolean {
    const after = this.#input[this.#pos + 1];

    return after !== undefined && STATIC_TOKENS[after] === undefined;
  }
}

// --- nodes -----------------------------------------------------------------

export type NodeType = "CAT" | "OR" | "GROUP" | "STAR" | "LITERAL" | "SYMBOL" | "SLASH" | "DOT";

export interface PatternNode {
  type: NodeType;
  left?: PatternNode | string;
  right?: PatternNode;
  children?: PatternNode[];
  /** The declared constraint on a symbol or star. */
  regexp?: RegExp;
  /** Whatever the router wants to hang off a terminal — usually the route. */
  memo?: unknown;
}

/** What a symbol matches when nothing constrains it. Rails' `DEFAULT_EXP`. */
export const DEFAULT_SEGMENT = /[^./?]+/;

/** What a `*glob` matches. Rails' `GREEDY_EXP`. */
export const GREEDY_SEGMENT = /(.+)/;

export function isTerminal(node: PatternNode): boolean {
  return (
    node.type === "LITERAL" ||
    node.type === "SYMBOL" ||
    node.type === "SLASH" ||
    node.type === "DOT"
  );
}

export function isSymbol(node: PatternNode): boolean {
  return node.type === "SYMBOL";
}

export function isStar(node: PatternNode): boolean {
  return node.type === "STAR";
}

export function isGroup(node: PatternNode): boolean {
  return node.type === "GROUP";
}

/** The name a symbol or star carries, without its sigil. Rails' `name`. */
export function nodeName(node: PatternNode): string {
  if (node.type === "STAR") return nodeName(node.left as PatternNode);

  return String(node.left ?? "").replace(/^[*:]/, "");
}

/** Rails' `to_sym`. */
export function toSym(node: PatternNode): string {
  return nodeName(node);
}

/** Every node, depth first. Rails' `Node#each` via `Visitors::Each`. */
export function eachNode(node: PatternNode): PatternNode[] {
  const collected: PatternNode[] = [node];

  for (const child of childrenOf(node)) collected.push(...eachNode(child));

  return collected;
}

export function childrenOf(node: PatternNode): PatternNode[] {
  if (node.children) return node.children;
  if (node.right) return [node.left as PatternNode, node.right];
  if (node.left && typeof node.left !== "string") return [node.left];

  return [];
}

export type VisitorMethods<T> = {
  [K in NodeType as `visit_${K}`]?: (node: PatternNode, visit: (child: PatternNode) => T) => T;
};

export class UnhandledNodeType extends Error {
  constructor(type: NodeType, visitor: string) {
    super(
      `${visitor} has no visit_${type}. Every traversal has to handle all eight node types: one ` +
        `that quietly skipped a type would produce output that is almost right — a regexp ` +
        `missing an optional group, a path missing a separator — which is harder to notice than ` +
        `a crash.`,
    );
    this.name = "UnhandledNodeType";
  }
}

/**
 * Rails' `Visitor#accept` — dispatch one node to its method.
 *
 * Refuses an unhandled type by name rather than falling through to a default.
 * A default is what turns a missing case into output that is nearly correct.
 */
export function accept<T>(node: PatternNode, methods: VisitorMethods<T>, name = "This visitor"): T {
  const method = methods[`visit_${node.type}` as keyof VisitorMethods<T>] as
    | ((node: PatternNode, visit: (child: PatternNode) => T) => T)
    | undefined;

  if (method === undefined) throw new UnhandledNodeType(node.type, name);

  return method(node, (child) => accept(child, methods, name));
}

/**
 * The pattern a tree came from. Rails' `Visitors::String`.
 *
 * Written as a visitor rather than a switch so that adding a node type breaks
 * every traversal that has not been taught about it. A `default:` branch here
 * would render an unknown node as its left child — a path that is *almost*
 * right, which is the failure this whole layer exists to make impossible.
 */
export const pathVisitor: VisitorMethods<string> = {
  visit_CAT: (node, visit) => visit(node.left as PatternNode) + visit(node.right as PatternNode),
  visit_OR: (node, visit) => (node.children ?? []).map((child) => visit(child)).join("|"),
  visit_GROUP: (node, visit) => `(${visit(node.left as PatternNode)})`,
  visit_STAR: (node) => `*${nodeName(node)}`,
  visit_SYMBOL: (node) => `:${nodeName(node)}`,
  visit_SLASH: (node) => String(node.left ?? "/"),
  visit_DOT: (node) => String(node.left ?? "."),
  visit_LITERAL: (node) => String(node.left ?? ""),
};

export function toPath(node: PatternNode): string {
  return accept(node, pathVisitor, "The path visitor");
}

/** The tree as Graphviz source, for `rails routes --expanded`. Rails' `to_dot`. */
export function toDot(node: PatternNode): string {
  const lines: string[] = ["digraph pattern {", "  node [shape=box];"];
  const nodes = eachNode(node);
  const idOf = new Map(nodes.map((each, index) => [each, index]));

  for (const each of nodes) {
    const label = each.type === "CAT" || each.type === "OR" ? each.type : toPath(each);

    lines.push(`  ${idOf.get(each)} [label=${JSON.stringify(label)}];`);

    for (const child of childrenOf(each)) {
      lines.push(`  ${idOf.get(each)} -> ${idOf.get(child)};`);
    }
  }

  lines.push("}");

  return lines.join("\n");
}

// --- parser ----------------------------------------------------------------

export class PatternSyntaxError extends Error {
  constructor(message: string, pattern: string) {
    super(`${message} in route pattern ${JSON.stringify(pattern)}.`);
    this.name = "PatternSyntaxError";
  }
}

/**
 * Builds the tree. Rails' `Journey::Parser`.
 *
 * Recursive descent over four productions: a concatenation of expressions, an
 * alternation, a group, and a terminal. Small enough to read, which matters
 * more here than it looks — this decides what every URL in an application
 * means, and a subtle wrong answer routes requests somewhere plausible.
 */
export function parsePattern(pattern: string): PatternNode {
  const scanner = new Scanner();
  scanner.scanSetup(pattern);

  let token = scanner.nextToken();
  const advance = () => {
    token = scanner.nextToken();
  };

  const parseTerminal = (): PatternNode => {
    let node: PatternNode;

    switch (token) {
      case "SYMBOL":
        node = { type: "SYMBOL", left: scanner.lastString(), regexp: DEFAULT_SEGMENT };
        break;
      case "LITERAL":
        node = { type: "LITERAL", left: scanner.lastLiteral() };
        break;
      case "SLASH":
        node = { type: "SLASH", left: "/" };
        break;
      case "DOT":
        node = { type: "DOT", left: "." };
        break;
      default:
        throw new PatternSyntaxError(`Unexpected ${token ?? "end of pattern"}`, pattern);
    }

    advance();

    return node;
  };

  const parseStar = (): PatternNode => {
    const node: PatternNode = {
      type: "STAR",
      left: { type: "SYMBOL", left: scanner.lastString(), regexp: GREEDY_SEGMENT },
      regexp: /.+?/,
    };
    advance();

    return node;
  };

  const parseGroup = (): PatternNode => {
    advance();
    const inner = parseExpressions();

    // Rails raises here rather than closing the group for the caller. An
    // unbalanced parenthesis means the author meant something else entirely,
    // and guessing produces a route that exists but is not the one they wrote.
    if (token !== "RPAREN") throw new PatternSyntaxError("Missing right parenthesis", pattern);

    advance();

    return { type: "GROUP", left: inner };
  };

  const parseExpression = (): PatternNode => {
    if (token === "STAR") return parseStar();
    if (token === "LPAREN") return parseGroup();

    return parseTerminal();
  };

  function parseExpressions(): PatternNode {
    let node = parseExpression();

    while (token !== undefined) {
      if (token === "RPAREN") break;

      if (token === "OR") {
        advance();
        node = { type: "OR", children: [node, parseExpression()] };
        continue;
      }

      node = { type: "CAT", left: node, right: parseExpressions() };
    }

    return node;
  }

  if (token === undefined) throw new PatternSyntaxError("Empty pattern", pattern);

  return parseExpressions();
}

// --- the parsed pattern ----------------------------------------------------

/** What a parsed tree knows about itself. Rails' `Journey::Ast`. */
export interface Ast {
  tree: PatternNode;
  names: string[];
  pathParams: string[];
  terminals: PatternNode[];
  wildcardOptions: Record<string, RegExp>;
  glob: boolean;
}

export function buildAst(tree: PatternNode, formatted = true): Ast {
  const names: string[] = [];
  const terminals: PatternNode[] = [];
  const wildcardOptions: Record<string, RegExp> = {};
  let glob = false;

  for (const node of eachNode(tree)) {
    if (isSymbol(node)) names.push(nodeName(node));

    if (isStar(node)) {
      glob = true;

      // A wildcard is non-greedy by default so that `/*path` still leaves the
      // trailing `.json` for the format segment — greedy, it swallows the
      // format and every such request renders HTML.
      if (formatted) wildcardOptions[nodeName(node)] ??= /.+?/;
    }

    if (isTerminal(node)) terminals.push(node);
  }

  return { tree, names, pathParams: [...names], terminals, wildcardOptions, glob };
}

/** Hangs a value off every terminal, so a match can say which route it was. Rails' `route=`. */
export function addMemo(ast: Ast, memo: unknown): void {
  for (const terminal of ast.terminals) terminal.memo = memo;
}

/** Applies declared constraints to the symbols they name. Rails' `requirements=`. */
export function applyRequirements(ast: Ast, requirements: Record<string, RegExp>): void {
  for (const node of eachNode(ast.tree)) {
    if (!isSymbol(node) && !isStar(node)) continue;

    const declared = requirements[nodeName(node)];

    if (declared) node.regexp = declared;
  }
}

const regexpCache = new Map<string, RegExp>();

/**
 * One regexp object per source. Rails' `dedup_regexp`.
 *
 * An application has thousands of routes and a handful of distinct constraints
 * between them, and the router holds every one for the life of the process.
 */
export function dedupRegexp(source: string, flags = ""): RegExp {
  const key = `${flags}/${source}`;
  const held = regexpCache.get(key);

  if (held) return held;

  const built = new RegExp(source, flags);
  regexpCache.set(key, built);

  return built;
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceOf(constraint: RegExp): string {
  return constraint.source.replace(/^\^/, "").replace(/\$$/, "");
}

/**
 * The regexp a pattern compiles to. Rails' `AnchoredRegexp` visitor.
 *
 * Every literal is escaped. An unescaped `.` matches any character, so a route
 * for `/robots.txt` would also serve `/robotsXtxt` — and more usefully to an
 * attacker, a literal segment containing a `+` or `(` becomes a quantifier or
 * a capture group and quietly changes what the route accepts.
 */
export const regexpVisitor: VisitorMethods<string> = {
  visit_CAT: (node, visit) => visit(node.left as PatternNode) + visit(node.right as PatternNode),
  visit_OR: (node, visit) => `(?:${(node.children ?? []).map((child) => visit(child)).join("|")})`,
  visit_GROUP: (node, visit) => `(?:${visit(node.left as PatternNode)})?`,
  visit_STAR: (node) => `(${node.regexp ? sourceOf(node.regexp) : ".+"})`,

  // `[^./?]+` rather than "anything but a separator": a segment that could
  // contain a dot swallows the `.json` that an optional `(.:format)` group was
  // there to catch, and every such request then renders HTML.
  visit_SYMBOL: (node) => `(${sourceOf(node.regexp ?? DEFAULT_SEGMENT)})`,
  visit_SLASH: () => "/",
  visit_DOT: (node) => escapeLiteral(String(node.left ?? ".")),
  visit_LITERAL: (node) => escapeLiteral(String(node.left ?? "")),
};

export function toRegexpSource(node: PatternNode): string {
  return accept(node, regexpVisitor, "The regexp visitor");
}

export interface CompiledPattern {
  ast: Ast;
  regexp: RegExp;
  names: string[];
  requiredNames: string[];
  optionalNames: string[];
  anchored: boolean;
}

/**
 * Compiles a pattern. Rails' `Journey::Path::Pattern`.
 *
 * Anchored at both ends unless told otherwise. An unanchored route pattern
 * matches anywhere in the path, so `/admin` would match `/public/admin` and
 * `/x/admin/y` — which is a route matching more than it says, on the one part
 * of an application where that matters most. `mount` is the case that wants it
 * unanchored, and it asks explicitly.
 */
export function compilePattern(
  pattern: string,
  requirements: Record<string, RegExp> = {},
  { anchored = true, formatted = true } = {},
): CompiledPattern {
  const ast = buildAst(parsePattern(pattern), formatted);
  applyRequirements(ast, { ...ast.wildcardOptions, ...requirements });

  const source = toRegexpSource(ast.tree);
  const regexp = anchored
    ? dedupRegexp(`^${source}$`)
    : dedupRegexp(source === "/" ? "^/" : `^${source}(?:\\b|$|/)`);

  const optionalNames = optionalNamesOf(ast.tree);

  return {
    ast,
    regexp,
    names: ast.names,
    requiredNames: ast.names.filter((name) => !optionalNames.includes(name)),
    optionalNames,
    anchored,
  };
}

/** The symbols inside an optional group. Rails' `optional_names`. */
export function optionalNamesOf(tree: PatternNode): string[] {
  const found = new Set<string>();

  for (const node of eachNode(tree)) {
    if (!isGroup(node)) continue;

    for (const inner of eachNode(node)) {
      if (isSymbol(inner)) found.add(nodeName(inner));
    }
  }

  return [...found];
}

/** Rails' `required_names`. */
export function requiredNames(compiled: CompiledPattern): string[] {
  return compiled.requiredNames;
}

/**
 * Whether the pattern can be matched piece by piece. Rails'
 * `requirements_anchored?`.
 *
 * False when a symbol sits directly against a literal, because then there is
 * no separator saying where the parameter stops — `/:idx` cannot be chunked,
 * and the router has to fall back to running the whole regexp.
 */
export function requirementsAnchored(ast: Ast): boolean {
  return ast.terminals.every((node, index) => {
    if (index < 1) return true;
    if (node.type === "DOT" || node.type === "SLASH") return true;

    const back = ast.terminals[index - 1];
    const forward = ast.terminals[index + 1];

    if (back?.type === "LITERAL") return false;
    if (forward?.type === "LITERAL") return false;

    return true;
  });
}

/**
 * Each declared constraint anchored on its own. Rails'
 * `requirements_for_missing_keys_check`.
 *
 * Anchoring matters here more than anywhere: an unanchored `\d+` says "contains
 * a digit", so a constraint meant to accept only numeric ids accepts `12abc`
 * — and the value reaches the action, which passes it to the database.
 */
export function requirementsForMissingKeysCheck(
  requirements: Record<string, RegExp>,
): Record<string, RegExp> {
  return Object.fromEntries(
    Object.entries(requirements).map(([name, constraint]) => [
      name,
      dedupRegexp(`^${sourceOf(constraint)}$`),
    ]),
  );
}

/** What a match found. Rails' `Journey::Path::Pattern::MatchData`. */
export interface PatternMatch {
  names: string[];
  params: Record<string, string>;
}

export function matchPattern(compiled: CompiledPattern, path: string): PatternMatch | null {
  const found = compiled.regexp.exec(path);

  if (!found) return null;

  const params: Record<string, string> = {};

  compiled.names.forEach((name, index) => {
    const value = found[index + 1];

    // An unmatched optional group captures `undefined`, which is not the same
    // as an empty segment — leaving the key out lets a default fill it.
    if (value !== undefined) params[name] = value;
  });

  return { names: compiled.names, params };
}

// --- formatting back to a path ---------------------------------------------

/** A hole in a path, and how its value has to be escaped. Rails' `Format::Parameter`. */
export interface FormatParameter {
  name: string;
  escape: (value: string) => string;
}

/** Rails' `required_path` — a `*glob`, where slashes are part of the value. */
export function requiredPath(name: string): FormatParameter {
  return { name, escape: (value) => encodeURI(value) };
}

/**
 * Rails' `required_segment` — a `:symbol`, where a slash is not.
 *
 * `encodeURIComponent`, not `encodeURI`: a slash inside a segment value would
 * otherwise become an extra path segment, so a record whose slug contains one
 * generates a URL that routes somewhere else entirely.
 */
export function requiredSegment(name: string): FormatParameter {
  return { name, escape: (value) => encodeURIComponent(value) };
}

export type FormatPart = string | FormatParameter | Format;

/** A path with holes in it, built once per route. Rails' `Journey::Format`. */
export class Format {
  constructor(private readonly parts: readonly FormatPart[]) {}

  /**
   * Fills the holes. Rails' `Format#evaluate`.
   *
   * A missing value collapses the whole part to nothing rather than
   * interpolating "undefined" — which is how an optional `(.:format)` group
   * disappears when no format was asked for.
   */
  evaluate(values: Record<string, unknown>): string {
    let built = "";

    for (const part of this.parts) {
      if (typeof part === "string") {
        built += part;
        continue;
      }

      if (part instanceof Format) {
        built += part.evaluate(values);
        continue;
      }

      const value = values[part.name];

      if (value === null || value === undefined) return "";

      built += part.escape(String(value));
    }

    return built;
  }
}

/** Turns a tree into something that can generate paths. Rails' `build_formatter`. */
export function buildFormatter(node: PatternNode): Format {
  const parts: FormatPart[] = [];

  const walk = (current: PatternNode, into: FormatPart[]): void => {
    switch (current.type) {
      case "CAT":
        walk(current.left as PatternNode, into);
        walk(current.right as PatternNode, into);

        return;
      case "GROUP": {
        const inner: FormatPart[] = [];
        walk(current.left as PatternNode, inner);
        into.push(new Format(inner));

        return;
      }
      case "OR":
        // Only the first branch can be generated: the others match the same
        // route, and picking between them would need a rule the pattern does
        // not carry.
        walk((current.children ?? [])[0] as PatternNode, into);

        return;
      case "SYMBOL":
        into.push(requiredSegment(nodeName(current)));

        return;
      case "STAR":
        into.push(requiredPath(nodeName(current)));

        return;
      default:
        into.push(String(current.left ?? ""));
    }
  };

  walk(node, parts);

  return new Format(parts);
}
