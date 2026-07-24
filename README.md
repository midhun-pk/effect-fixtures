# effect-fixtures

Generate configurable test fixtures from [Effect](https://effect.website) schemas.

```ts
import { Schema as S } from 'effect';
import { createFixture, GENERATE } from 'effect-fixtures';

const Order = S.Struct({
  id: S.UUID,
  reference: S.String.pipe(S.minLength(1)),
  status: S.Literal('draft', 'placed', 'shipped'),
  placed_at: S.optional(S.NullOr(S.Date)),
  shipping: S.Struct({
    method: S.Literal('standard', 'express'),
    cost: S.Number,
    tracking: S.optional(S.String),
  }),
});

const makeOrder = createFixture(Order, { defaults: { status: 'placed' } });

makeOrder();
// {
//      id: '43544fba-…',
//      reference: 'reference-mrxlje9d1',
//      status: 'placed',
//      shipping: {
//          method: 'standard',
//          cost: 1,
//      }
// }

makeOrder({ reference: 'ORD-1' });              // one field pinned
makeOrder({ shipping: { method: 'express' } }); // nested; `cost` still generated
makeOrder({ placed_at: GENERATE });             // optional field in, value generated
makeOrder({ placed_at: null });                 // explicit null
makeOrder.raw({ reference: '' });               // skip validation, for negative tests
```

## The two rules

1. **Required fields get a generated value.** Constraints on the refinement
   chain are honoured: `minLength`/`maxLength`, `int`, numeric bounds,
   `multipleOf`, `minItems`, `pattern` (satisfied by candidate testing — an
   unsatisfiable pattern throws, naming the field, rather than emitting a value
   the server will reject).
2. **Optional fields are omitted** — the key is absent, not `undefined` — so the
   default output is the *minimal* payload the schema accepts. Naming a field in
   an override is what opts it in; `GENERATE` opts it in without dictating the
   value; `includeOptional: true` opts in everything.

Every build (except `.raw()`) is validated by decoding it back through the
schema, so a bad override or a missing generator fails at the arrange step with
the offending field named.

## Values are the encoded (wire) side

Fixtures are for sending, so generation targets `Schema.Encoded<S>`, not the
decoded type: a `S.Date` field comes out as an ISO string, `S.NumberFromString`
as `'1'`. Transformations that ship with `effect` (`Date`, `DateTimeUtc`,
`NumberFromString`, `BigInt`, `ULID`, the `Uint8Array` codecs, …) have built-in
defaults; your own codecs use [generators](#generators).

## API

### `createFixture(schema, options?)`

Returns a `Fixture<Schema.Encoded<S>>`: a function taking a deep-partial
override, with a `.raw()` variant that skips validation.

| option | what it does |
|---|---|
| `defaults` | Merged into every build, below per-call overrides. For the field whose generated value is valid but useless — `status: 'placed'` when the generated default would be `'draft'`. |
| `generators` | `Record<string, (ctx) => unknown>`. Looked up by full path (`shipping.method`), then field name (`method`), then the schema's `identifier` annotation. |
| `includeOptional` | Fill optional fields instead of omitting them. Default `false`. |
| `seed` | Makes builds byte-identical: the unique token becomes the seed, UUIDs come from a seeded PRNG, generated dates pin to the epoch. Without it every build is unique, so reruns against a shared environment don't collide. |
| `maxDepth` | Recursion budget for self-referential schemas. Default `12`. |

### Generators

The escape hatch for anything the AST can't describe: an opaque
`Schema.declare`, or a custom codec whose encoded side is a string with an
uninvertible format.

```ts
// Suppose the API's timestamps are epoch seconds carried as strings:
const UnixSeconds = S.transform(S.String, S.DateFromSelf, {
  strict: true,
  decode: (s) => new Date(Number(s) * 1000),
  encode: (d) => String(Math.floor(d.getTime() / 1000)),
}).annotations({ identifier: 'UnixSeconds' });

const makeOrder = createFixture(Order, {
  generators: {
    // by identifier annotation — covers EVERY field using this codec
    UnixSeconds: () => String(Math.floor(Date.now() / 1000)),
    // by field name — this field wherever it appears
    reference: (ctx) => `order-${ctx.token}`,
    // by full path — exactly one position
    'shipping.method': () => 'express',
  },
});
```

**The identifier key is the schema's `identifier` *annotation*, not the name of
the const it's bound to.** `export const MyDate = IsoDate` is annotated
`IsoDate`; registering under `MyDate` matches nothing. A plain
`pipe(S.String, ...)` carries no annotation and is only reachable by field name
or path. Getting this wrong is loud, not silent: the generated placeholder fails
validation and the error names the field.

The `ctx` argument carries `path`, `field`, `identifier`, and `token` (the
per-build uniqueness token — include it in generated names so runs don't
collide).

### `GENERATE`

A sentinel meaning "include this optional field, you pick the value":

```ts
makeOrder({ placed_at: GENERATE });               // generator/builtin fills it
makeOrder({ shipping: { tracking: GENERATE } });  // works nested
```

### Overrides in unions

Overrides route to the right union member. In a discriminated union the literal
fields decide; a partial override still generates the member's other fields:

```ts
const Shape = S.Union(
  S.Struct({ kind: S.Literal('circle'), radius: S.Number }),
  S.Struct({ kind: S.Literal('square'), side: S.Number }),
);

makeShape({ kind: 'square' });   // -> { kind: 'square', side: 1 }
```

## What it handles

Structs (incl. spread fields and symbol keys), `Schema.Class`, nested
composition, `optional` / `optionalWith` (a decode-side `default` stays off the
wire), `NullOr`, unions (incl. discriminated), literals, enums, template
literals, tuples (incl. `optionalElement`), arrays, records, branded types,
refinement chains, transformations, `suspend`/recursive schemas (recursion must
bottom out through an array/optional; unbounded recursion errors at `maxDepth`
instead of overflowing).

`Schema.declare`-based opaque types can't be generated from the AST — that's
what `generators` is for, and the error says so.

## Non-goals

- **Random/property-based data.** Builds are minimal and stable by design — the
  same shape every time, unique only where uniqueness prevents collisions. For
  randomized exploration of the value space, use Effect's own
  [`Arbitrary`](https://effect.website/docs/schema/arbitrary/) with fast-check;
  the two are complementary.

## License

MIT
