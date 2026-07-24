import { Option, Schema, SchemaAST as AST } from 'effect';

/**
 * Build test fixtures by reading an Effect schema.
 *
 * The schema is already the single source of truth for what a payload looks
 * like. Hand-written fixture objects duplicate it and then rot: a field goes
 * required upstream and every fixture keeps compiling while the API starts
 * rejecting the request. Here the shape is read at runtime from `schema.ast`,
 * so a schema change shows up the moment the fixture is built.
 *
 * Two rules define the default output:
 *   - required fields get a generated value,
 *   - optional fields are omitted entirely.
 * That yields the *minimal* payload the schema accepts, which is what a test
 * arranging a prerequisite wants. A test that cares about an optional field
 * passes it as an override, and only then does it appear.
 *
 * Values are generated on the ENCODED side — the wire shape you POST, not the
 * decoded domain shape, so a `Schema.Date` field comes out as an ISO string
 * rather than a `Date`. The walk descends the type-side AST and collapses each
 * node to `AST.encodedBoundAST` as it goes, rather than converting the tree up
 * front, for two reasons:
 *   - `encodedBound` stops at the first transformation, so it keeps the
 *     refinements that still constrain the wire value — a `pattern`, an `int`,
 *     a `minLength`. Plain `encodedAST` discards those and would cheerfully
 *     generate a string the server rejects.
 *   - the `identifier` annotation naming a transformation sits on the
 *     transformation node and is gone once collapsed. Reading it on the way
 *     down is what lets a generator be registered under that name.
 */

/** Where a value is being generated, for error messages and generator lookup. */
export interface FieldContext {
  /** Dotted path from the root, e.g. `shipping.method`. Empty at the root. */
  readonly path: string;
  /** The last path segment — the field's own name. */
  readonly field: string;
  /** The `identifier` annotation on the schema at this position, if any. */
  readonly identifier?: string | undefined;
  /** Per-build token; include it to keep generated values unique across runs. */
  readonly token: string;
}

export type FieldGenerator = (ctx: FieldContext) => unknown;

/**
 * Ask for an optional field to be present without saying what it holds.
 *
 * Omitting a field and pinning a field are the two obvious cases; this is the
 * third. A test that needs `created_at` to exist — because the column has to
 * render — but does not care what date it is, writes `{ created_at: GENERATE }`
 * and gets the value from whatever generator covers that field.
 */
export const GENERATE: unique symbol = Symbol.for('effect-fixtures/GENERATE');

/**
 * A recursively optional view of the encoded type. Overrides are matched
 * against this, so a nested field can be pinned without restating its siblings.
 */
export type DeepPartial<T> =
  | typeof GENERATE
  | (T extends ReadonlyArray<infer E> ? ReadonlyArray<DeepPartial<E>>
    : T extends object ? { readonly [K in keyof T]?: DeepPartial<T[K]> | undefined }
      : T);

export interface FixtureOptions<I> {
  /**
   * Values merged into every build, before the per-call overrides. Use this for
   * the field whose generated default is technically valid but practically
   * useless in every test — `status: 'placed'` on an order whose generated
   * default would be `'draft'`, say.
   */
  readonly defaults?: DeepPartial<I>;
  /**
   * Escape hatch for positions the AST can't describe on its own: an opaque
   * `Schema.declare`, or a string whose real format lives in a regex the
   * generator can't invert. Looked up by full path (`shipping.method`), then
   * by field name (`method`), then by the schema's `identifier` annotation.
   *
   * The identifier key is the schema's *annotation*, not the name of the const
   * it is bound to, and the two often differ: `export const MyDate = IsoDate`
   * is annotated `IsoDate`, so that is the key that works. A plain
   * `pipe(Schema.String, ...)` carries no annotation at all and can only be
   * reached by field name or path. Getting this wrong is not silent — the
   * unmatched generator leaves a generated value that fails validation, and
   * the error names the field.
   */
  readonly generators?: Readonly<Record<string, FieldGenerator>>;
  /** Fill optional fields too, instead of omitting them. Default `false`. */
  readonly includeOptional?: boolean;
  /**
   * Fix all randomness so repeated builds are byte-identical: the unique token
   * becomes the seed, UUIDs come from a PRNG keyed on it, and generated dates
   * pin to the epoch. Only for tests asserting on the generator itself — a
   * shared environment needs the default per-build uniqueness, or the second
   * run collides with the first run's records.
   */
  readonly seed?: string | number;
  /**
   * How deep the walk may recurse before giving up on a self-referential
   * schema whose required fields never bottom out. Default `12`.
   */
  readonly maxDepth?: number;
}

/** Builds one fixture. `raw` skips validation, for deliberately invalid input. */
export interface Fixture<I, A = unknown> {
  (overrides?: DeepPartial<I>): I;
  /**
   * Same build, without the decode check. Negative tests need to send a payload
   * the schema rejects; that is the only reason to reach for this.
   */
  readonly raw: (overrides?: DeepPartial<I>) => I;
  /**
   * Same build, but returning the DECODED value — dates as `Date`s, class
   * instances constructed, `optionalWith` defaults applied. For the test that
   * consumes the domain value rather than sending the wire payload. Validation
   * is the same decode, so it costs nothing extra and fails identically.
   */
  readonly decoded: (overrides?: DeepPartial<I>) => A;
}

/** Constraints collected off a refinement chain, as JSON Schema keywords. */
interface Constraints {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  integer?: boolean;
  pattern?: string;
  format?: string;
}

interface BuildState {
  readonly generators: Readonly<Record<string, FieldGenerator>>;
  readonly includeOptional: boolean;
  readonly maxDepth: number;
  /** Present only when seeded; drives every random choice in the build. */
  readonly random?: (() => number) | undefined;
}

let builds = 0;

/** Unique per build, short enough to stay readable inside a generated name. */
const nextToken = (): string => {
  builds += 1;
  return `${Date.now().toString(36)}${builds.toString(36)}`;
};

/** FNV-1a; a seed string has to become a PRNG state somehow. */
const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** Mulberry32: tiny, fast, and plenty for fixture determinism. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** RFC 4122 v4 layout, but from the seeded PRNG instead of the CSPRNG. */
const uuidFrom = (random: () => number): string => {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Annotation lookups all return `Option`; nothing here distinguishes absent from unset. */
const some = Option.getOrUndefined;

const isPlainObject = (value: unknown): value is Record<PropertyKey, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** `optional(NullOr(x))` nests unions three deep; flat is far easier to reason about. */
const flattenUnion = (ast: AST.AST): ReadonlyArray<AST.AST> => (
  AST.isUnion(ast) ? ast.types.flatMap(flattenUnion) : [ast]
);

const isNullLiteral = (ast: AST.AST): boolean => AST.isLiteral(ast) && ast.literal === null;

/** Strip refinements down to the node that actually says what the value *is*. */
const baseOf = (ast: AST.AST): AST.AST => (AST.isRefinement(ast) ? baseOf(ast.from) : ast);

/**
 * Walk the refinement chain and merge every JSON Schema annotation on it.
 * `Number.pipe(int(), greaterThanOrEqualTo(0))` is two nested refinements,
 * each carrying one keyword; only together do they describe the value.
 */
const constraintsOf = (ast: AST.AST): Constraints => {
  const out: Constraints = {};

  for (let node: AST.AST = ast; AST.isRefinement(node); node = node.from) {
    const json = some(AST.getJSONSchemaAnnotation(node)) as Record<string, unknown> | undefined;
    if (json) {
      if (typeof json.minLength === 'number') out.minLength = json.minLength;
      if (typeof json.maxLength === 'number') out.maxLength = json.maxLength;
      if (typeof json.minimum === 'number') out.minimum = json.minimum;
      if (typeof json.maximum === 'number') out.maximum = json.maximum;
      if (typeof json.exclusiveMinimum === 'number') out.exclusiveMinimum = json.exclusiveMinimum;
      if (typeof json.exclusiveMaximum === 'number') out.exclusiveMaximum = json.exclusiveMaximum;
      if (typeof json.multipleOf === 'number') out.multipleOf = json.multipleOf;
      if (typeof json.minItems === 'number') out.minItems = json.minItems;
      if (typeof json.pattern === 'string') out.pattern = json.pattern;
      if (typeof json.format === 'string') out.format = json.format;
      if (json.type === 'integer') out.integer = true;
    }
  }

  return out;
};

/** The identifier can sit on any link of the refinement chain; take the first. */
const identifierOf = (ast: AST.AST): string | undefined => {
  for (let node: AST.AST = ast; ; node = node.from) {
    const id = some(AST.getIdentifierAnnotation(node));
    if (id !== undefined) return id;
    if (!AST.isRefinement(node)) return undefined;
  }
};

const fail = (ctx: FieldContext, message: string): never => {
  const at = ctx.path === '' ? 'the root' : `\`${ctx.path}\``;
  throw new Error(
    `effect-fixtures: cannot generate a value for ${at} — ${message}\n`
    + `Pass it as an override, or register a generator under '${ctx.path}'`
    + `${ctx.identifier !== undefined ? ` or '${ctx.identifier}'` : ''}.`,
  );
};

/**
 * Defaults for the transformations that ship with `effect` and whose encoded
 * side collapses to an unconstrained primitive — a bare string that must
 * nevertheless parse as a date, a number, a ULID. Structural generation cannot
 * know that; the identifier that every built-in carries can. Keyed exactly like
 * user generators, and consulted after them, so a user entry under the same
 * name wins.
 */
const builtinDefaults: Readonly<Record<string, (ctx: FieldContext, seeded: boolean) => unknown>> = {
  Date: (_, seeded) => (seeded ? new Date(0) : new Date()).toISOString(),
  DateFromString: (_, seeded) => (seeded ? new Date(0) : new Date()).toISOString(),
  DateTimeUtc: (_, seeded) => (seeded ? new Date(0) : new Date()).toISOString(),
  NumberFromString: () => '1',
  BigInt: () => '1',
  BigIntFromNumber: () => 1,
  ULID: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  Uint8ArrayFromBase64: () => '',
  Uint8ArrayFromBase64Url: () => '',
  Uint8ArrayFromHex: () => '',
};

/**
 * A string satisfying `constraints`. Length is solvable; a regex is not — the
 * general case of inverting one has no answer, so candidates are tried against
 * it and an unmatched pattern becomes an error naming the field rather than a
 * value the server will reject later.
 */
const makeString = (ctx: FieldContext, constraints: Constraints, state: BuildState): string => {
  if (constraints.format === 'uuid') {
    return state.random ? uuidFrom(state.random) : crypto.randomUUID();
  }

  const fit = (value: string): string => {
    const { minLength = 0, maxLength } = constraints;
    const padded = value.length >= minLength ? value : value.padEnd(minLength, 'x');
    return maxLength !== undefined && padded.length > maxLength
      ? padded.slice(0, maxLength)
      : padded;
  };

  const base = ctx.field === '' ? 'value' : ctx.field;
  const candidates = [`${base}-${ctx.token}`, base, ctx.token, 'test', 'A', '0'].map(fit);

  if (constraints.pattern === undefined) return candidates[0] as string;

  const re = new RegExp(constraints.pattern);
  const match = candidates.find((candidate) => re.test(candidate));

  return match ?? fail(ctx, `no default matches the pattern /${constraints.pattern}/`);
};

const makeNumber = (ctx: FieldContext, constraints: Constraints): number => {
  const {
    minimum, maximum, exclusiveMinimum, exclusiveMaximum, integer, multipleOf,
  } = constraints;

  let lower = minimum ?? (exclusiveMinimum !== undefined ? exclusiveMinimum + 1 : undefined);
  let upper = maximum ?? (exclusiveMaximum !== undefined ? exclusiveMaximum - 1 : undefined);

  if (integer) {
    lower = lower !== undefined ? Math.ceil(lower) : undefined;
    upper = upper !== undefined ? Math.floor(upper) : undefined;
  }

  // 1 rather than 0: a fixture is more often a count or an id than a zero, and
  // 0 trips `!value` checks in application code under test.
  let value = lower ?? 1;
  if (multipleOf !== undefined) {
    value = Math.ceil(value / multipleOf) * multipleOf;
  }
  if (upper !== undefined && value > upper) value = upper;
  if (lower !== undefined && value < lower) {
    return fail(ctx, 'no number satisfies the combined range constraints');
  }

  return value;
};

/**
 * Score a union member against an object override by its literal fields — the
 * discriminated-union case. A literal the override contradicts disqualifies
 * the member; a literal it matches is evidence for it. `Union(Circle, Square)`
 * with `{ kind: 'square', … }` must generate a square, not the first member.
 */
const discriminatorScore = (
  member: AST.AST,
  override: Record<PropertyKey, unknown>,
): number => {
  const base = baseOf(member);
  if (!AST.isTypeLiteral(base)) return -1;

  let score = 0;
  for (const property of base.propertySignatures) {
    const propertyBase = baseOf(property.type);
    if (
      AST.isLiteral(propertyBase)
      && Object.prototype.hasOwnProperty.call(override, property.name)
    ) {
      if (override[property.name] !== propertyBase.literal) return -1;
      score += 1;
    }
  }

  return score;
};

/**
 * Pick the union member to generate. `optional(NullOr(X))` means the flattened
 * members are `X | null | undefined`; a required field wants a real `X`, so
 * null and undefined are last resorts, not first choices. When the caller
 * supplied an override, the member has to be the one the override describes.
 */
const pickMember = (
  members: ReadonlyArray<AST.AST>,
  override: unknown,
  provided: boolean,
): AST.AST | undefined => {
  const real = members.filter((m) => !AST.isUndefinedKeyword(m) && !isNullLiteral(m));

  if (!provided) return real[0] ?? members[0];

  if (override === null) return members.find(isNullLiteral) ?? real[0];
  if (override === undefined) return members.find(AST.isUndefinedKeyword) ?? real[0];

  if (isPlainObject(override)) {
    let best: AST.AST | undefined;
    let bestScore = -1;
    for (const member of real) {
      const score = discriminatorScore(member, override);
      if (score > bestScore) {
        best = member;
        bestScore = score;
      }
    }
    if (best !== undefined) return best;
    return real.find((m) => AST.isTypeLiteral(baseOf(m))) ?? real[0] ?? members[0];
  }

  // A scalar override: an exactly-equal literal member first, then the keyword
  // member of the matching primitive type.
  const exact = real.find((m) => {
    const base = baseOf(m);
    return AST.isLiteral(base) && base.literal === override;
  });
  if (exact) return exact;

  const matching = real.find((m) => {
    const base = baseOf(m);
    if (Array.isArray(override)) return AST.isTupleType(base);
    if (typeof override === 'string') {
      return AST.isStringKeyword(base) || AST.isTemplateLiteral(base);
    }
    if (typeof override === 'number') return AST.isNumberKeyword(base);
    if (typeof override === 'boolean') return AST.isBooleanKeyword(base);
    if (typeof override === 'bigint') return AST.isBigIntKeyword(base);
    return false;
  });

  return matching ?? real[0] ?? members[0];
};

/**
 * Generate one value for `ast`.
 *
 * `provided` distinguishes "the caller passed undefined" from "the caller
 * passed nothing" — on an optional field those mean opposite things, and
 * `override === undefined` alone cannot tell them apart.
 */
const generate = (
  ast: AST.AST,
  ctx: FieldContext,
  override: unknown,
  provided: boolean,
  state: BuildState,
  depth: number,
): unknown => {
  if (depth > state.maxDepth) {
    return fail(ctx, `the schema recurses past ${state.maxDepth} levels`);
  }

  // GENERATE opts a field in without dictating its value; from here down it is
  // indistinguishable from a field nobody mentioned. Terminates immediately —
  // the recursive call no longer carries the sentinel.
  if (override === GENERATE) {
    return generate(ast, ctx, undefined, false, state, depth);
  }

  const identifier = identifierOf(ast);
  const here: FieldContext = { ...ctx, identifier };

  // A scalar override is the answer; an object/array one still has to be
  // generated *through*, so its unspecified siblings get filled in.
  if (provided && !isPlainObject(override) && !Array.isArray(override)) {
    return override;
  }

  if (!provided) {
    const generator = state.generators[here.path]
      ?? state.generators[here.field]
      ?? (identifier !== undefined ? state.generators[identifier] : undefined);
    if (generator) return generator(here);

    // A schema that documents itself already says what a good value looks like.
    const annotated = some(AST.getDefaultAnnotation(ast))
      ?? some(AST.getExamplesAnnotation(ast))?.[0];
    if (annotated !== undefined) return annotated;

    const builtin = identifier !== undefined ? builtinDefaults[identifier] : undefined;
    if (builtin) return builtin(here, state.random !== undefined);
  }

  // A transformation's type side is the decoded domain value (a `Date`); the
  // wire carries its encoded side (a string). Swap to that here rather than up
  // front, because the `identifier` that names the transformation lives on the
  // transformation node and does not survive the swap. Reading it above and
  // collapsing here is what keeps identifier-keyed generators working.
  const wire = AST.isTransformation(baseOf(ast)) ? AST.encodedBoundAST(ast) : ast;
  const constraints = constraintsOf(wire);
  const base = baseOf(wire);

  switch (base._tag) {
    case 'StringKeyword':
      return makeString(here, constraints, state);

    case 'NumberKeyword':
      return makeNumber(here, constraints);

    case 'BooleanKeyword':
      // False is the neutral choice, but it is wrong as often as it is right —
      // an `enabled` flag wants `true`. That is what `defaults` is for.
      return false;

    case 'BigIntKeyword':
      return BigInt(makeNumber(here, constraints));

    case 'SymbolKeyword':
      return Symbol(here.token);

    case 'Literal':
      return base.literal;

    case 'UniqueSymbol':
      return base.symbol;

    case 'Enums':
      return base.enums.length > 0
        ? (base.enums[0] as readonly [string, string | number])[1]
        : fail(here, 'the enum has no members');

    case 'TemplateLiteral':
      return base.spans.reduce<string>(
        (acc, span) => acc
          + String(generate(span.type, here, undefined, false, state, depth + 1))
          + span.literal,
        base.head,
      );

    case 'UndefinedKeyword':
    case 'VoidKeyword':
      return undefined;

    case 'AnyKeyword':
    case 'UnknownKeyword':
    case 'ObjectKeyword':
      return {};

    case 'Suspend':
      return generate(base.f(), here, override, provided, state, depth + 1);

    case 'Union': {
      const member = pickMember(flattenUnion(base), override, provided);
      return member === undefined
        ? fail(here, 'the union has no members')
        : generate(member, here, override, provided, state, depth + 1);
    }

    case 'TupleType': {
      const { elements, rest } = base;
      const overrides = Array.isArray(override) ? override : undefined;

      // Fixed-arity part. Optional elements follow the same rule as optional
      // struct fields: omitted unless the override reaches them. Effect only
      // allows optional elements at the tail, so stopping early stays valid.
      const fixed: unknown[] = [];
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index] as AST.OptionalType;
        const reached = overrides !== undefined && index < overrides.length;
        if (element.isOptional && !reached && !state.includeOptional) break;
        fixed.push(generate(
          element.type,
          { ...here, path: `${here.path}[${index}]` },
          overrides?.[index],
          reached,
          state,
          depth + 1,
        ));
      }

      if (rest.length === 0) return fixed;

      // Variadic part. An override array sets the length — `[{ name: 'a' }, {}]`
      // means two generated elements, the first with `name` pinned — otherwise
      // `minItems` does, and an unconstrained array defaults to empty.
      const restType = (rest[0] as AST.Type).type;
      const extra = overrides !== undefined
        ? overrides.slice(elements.length)
        : new Array(Math.max(0, (constraints.minItems ?? 0) - elements.length)).fill(undefined);

      return [
        ...fixed,
        ...extra.map((item, index) => generate(
          restType,
          { ...here, path: `${here.path}[${elements.length + index}]` },
          item,
          overrides !== undefined,
          state,
          depth + 1,
        )),
      ];
    }

    case 'TypeLiteral': {
      const source = isPlainObject(override) ? override : undefined;
      const out: Record<PropertyKey, unknown> = {};

      for (const property of base.propertySignatures) {
        const key = property.name;
        // Symbol keys can't appear in a dotted path, but String(symbol) at
        // least names them in an error.
        const label = typeof key === 'symbol' ? String(key) : String(key);
        // Mentioning a field is what opts it in — omitting optionals is the
        // whole point of the default output. GENERATE counts as mentioning it;
        // the sentinel is unwrapped one level down, which is where "the caller
        // named this field" turns back into "generate it for me".
        const mentioned = source !== undefined
          && Object.prototype.hasOwnProperty.call(source, key);

        if (mentioned || !property.isOptional || state.includeOptional) {
          const value = generate(
            property.type,
            {
              ...here,
              path: here.path === '' ? label : `${here.path}.${label}`,
              field: label,
            },
            source?.[key],
            mentioned,
            state,
            depth + 1,
          );

          // A generated `undefined` on an optional field means "no value", and
          // an absent key reads better on the wire than an explicit undefined.
          if (value !== undefined || !property.isOptional) {
            out[key] = value;
          }
        }
      }

      // `Schema.Record` shows up here as an index signature with no declared
      // properties. There is nothing to generate without keys, so an empty
      // object is the default and overrides supply the entries.
      if (base.indexSignatures.length > 0 && source !== undefined) {
        const known = new Set<PropertyKey>(base.propertySignatures.map((p) => p.name));
        const valueType = (base.indexSignatures[0] as AST.IndexSignature).type;
        for (const [name, value] of Object.entries(source)) {
          if (!known.has(name)) {
            out[name] = generate(
              valueType,
              {
                ...here,
                path: here.path === '' ? name : `${here.path}.${name}`,
                field: name,
              },
              value,
              true,
              state,
              depth + 1,
            );
          }
        }
      }

      return out;
    }

    case 'Declaration':
      return fail(here, 'it is an opaque `Schema.declare` the AST cannot describe');

    default:
      return fail(here, `\`${base._tag}\` has no default value`);
  }
};

/** Deep-merge builder defaults under per-call overrides. Later wins; arrays replace. */
const mergeOverrides = (defaults: unknown, overrides: unknown): unknown => {
  if (overrides === undefined) return defaults;
  if (!isPlainObject(defaults) || !isPlainObject(overrides)) return overrides;

  const out: Record<PropertyKey, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = Object.prototype.hasOwnProperty.call(defaults, key)
      ? mergeOverrides(defaults[key], value)
      : value;
  }

  return out;
};

/**
 * Turn a schema into a fixture builder.
 *
 * ```ts
 * const makeOrder = createFixture(Order, { defaults: { status: 'placed' } });
 *
 * makeOrder();                           // minimal valid payload
 * makeOrder({ reference: 'ORD-1' });     // ...with one field pinned
 * makeOrder({ shipping: { method: 'express' } }); // ...nested, siblings still generated
 * ```
 *
 * The result is validated by decoding it through the schema, so a fixture that
 * the API would reject fails here instead — at the arrange step, with the
 * offending field named, rather than as a 400 three assertions later.
 */
export const createFixture = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  options: FixtureOptions<I> = {},
): Fixture<I, A> => {
  const decode = Schema.decodeUnknownSync(schema as Schema.Schema<A, I, never>);
  const label = identifierOf(schema.ast) ?? 'fixture';

  // The walk starts on the TYPE-side AST, not the encoded one, and collapses to
  // the wire shape per node as it descends. Converting the whole tree up front
  // would strip every identifier that sits on a transformation.
  const build = (overrides?: DeepPartial<I>): I => {
    const seeded = options.seed !== undefined;
    const state: BuildState = {
      generators: options.generators ?? {},
      includeOptional: options.includeOptional ?? false,
      maxDepth: options.maxDepth ?? 12,
      // A fresh PRNG per build, so every seeded build replays the same sequence.
      random: seeded ? mulberry32(hashString(String(options.seed))) : undefined,
    };

    return generate(
      schema.ast,
      {
        path: '',
        field: '',
        // One token per build, so two records created by one test get different
        // names, and a seeded builder repeats itself exactly.
        token: seeded ? String(options.seed) : nextToken(),
      },
      mergeOverrides(options.defaults, overrides),
      options.defaults !== undefined || overrides !== undefined,
      state,
      0,
    ) as I;
  };

  // Validation IS a decode; returning the result is what makes `decoded` free.
  const validate = (value: I): A => {
    try {
      return decode(value);
    } catch (cause) {
      throw new Error(
        `effect-fixtures: the generated ${label} does not satisfy its own schema.\n`
        + `${cause instanceof Error ? cause.message : String(cause)}\n`
        + 'Fix the override, or register a generator for the field named above.',
        { cause },
      );
    }
  };

  const fixture = (overrides?: DeepPartial<I>): I => {
    const value = build(overrides);
    validate(value);
    return value;
  };

  fixture.raw = build;
  fixture.decoded = (overrides?: DeepPartial<I>): A => validate(build(overrides));

  return fixture;
};
