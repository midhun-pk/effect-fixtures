import { Schema as S } from 'effect';
import { describe, expect, it } from 'vitest';
import { createFixture, GENERATE } from '../src/index.js';

/**
 * The cases that separate "works on the schema it was written against" from
 * "works on schemas in general": class schemas, transformations, discriminated
 * unions, tuples, template literals, symbol keys.
 */

describe('class schemas', () => {
  class User extends S.Class<User>('User')({
    id: S.UUID,
    name: S.String,
    bio: S.optional(S.String),
  }) {}

  it('builds the encoded object for a Schema.Class', () => {
    const value = createFixture(User)();

    expect(value.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(value.name).toEqual(expect.any(String));
    expect(value).not.toHaveProperty('bio');
  });

  it('accepts overrides like any struct', () => {
    expect(createFixture(User)({ name: 'Ada' }).name).toBe('Ada');
  });
});

describe('built-in transformations', () => {
  it('generates a decodable ISO string for Schema.Date', () => {
    const value = createFixture(S.Struct({ when: S.Date }))();

    expect(new Date(value.when).getTime()).not.toBeNaN();
  });

  it('pins Schema.Date to the epoch when seeded, for determinism', () => {
    const fixture = createFixture(S.Struct({ when: S.Date }), { seed: 's' });

    expect(fixture().when).toBe(new Date(0).toISOString());
    expect(fixture()).toEqual(fixture());
  });

  it('generates parseable strings for NumberFromString and BigInt', () => {
    const value = createFixture(S.Struct({
      count: S.NumberFromString,
      big: S.BigInt,
    }))();

    expect(value).toEqual({ count: '1', big: '1' });
  });

  it('generates a valid ULID', () => {
    const value = createFixture(S.Struct({ id: S.ULID }))();

    expect(value.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('handles DateTimeUtc, BooleanFromString and Duration', () => {
    const fixture = createFixture(S.Struct({
      at: S.DateTimeUtc,
      flag: S.BooleanFromString,
      wait: S.Duration,
    }));

    // The assertion is the validation built into the fixture call itself:
    // whatever was generated decoded successfully through all three codecs.
    expect(() => fixture()).not.toThrow();
  });

  it('handles Uint8Array codecs', () => {
    const value = createFixture(S.Struct({ blob: S.Uint8ArrayFromBase64 }))();

    expect(value.blob).toBe('');
  });

  it('lets a user generator beat the builtin under the same identifier', () => {
    const fixture = createFixture(S.Struct({ when: S.Date }), {
      generators: { Date: () => '2026-07-24T00:00:00.000Z' },
    });

    expect(fixture().when).toBe('2026-07-24T00:00:00.000Z');
  });

  it('fails with the field named when a custom codec has no generator', () => {
    // ValidDateFromSelf, not DateFromSelf: the latter accepts an Invalid Date
    // instance, so a garbage string would decode "successfully".
    const OddCodec = S.transform(S.String, S.ValidDateFromSelf, {
      strict: true,
      decode: (s) => new Date(Number(s)),
      encode: (d) => String(d.getTime()),
    }).annotations({ identifier: 'EpochMillis' });

    // 'stamp-<token>' is not a millisecond count, so decode rejects it and the
    // error tells the user what to register.
    expect(() => createFixture(S.Struct({ stamp: OddCodec }))())
      .toThrow(/stamp[\s\S]*register a generator/);
  });
});

describe('discriminated unions', () => {
  const Shape = S.Union(
    S.Struct({ kind: S.Literal('circle'), radius: S.Number }),
    S.Struct({ kind: S.Literal('square'), side: S.Number }),
  );

  it('generates the first member when nothing is specified', () => {
    const value = createFixture(S.Struct({ shape: Shape }))();

    expect(value.shape).toEqual({ kind: 'circle', radius: 1 });
  });

  it('picks the member the override discriminates to, not the first', () => {
    const value = createFixture(S.Struct({ shape: Shape }))({
      shape: { kind: 'square' },
    });

    expect(value.shape).toEqual({ kind: 'square', side: 1 });
  });

  it('completes the discriminated member from a partial override', () => {
    const value = createFixture(S.Struct({ shape: Shape }))({
      shape: { kind: 'square', side: 9 },
    });

    expect(value.shape).toEqual({ kind: 'square', side: 9 });
  });

  it('picks the exactly-matching literal in a scalar union', () => {
    const fixture = createFixture(S.Struct({ mode: S.Literal('read', 'write', 'admin') }));

    expect(fixture({ mode: 'write' }).mode).toBe('write');
  });

  it('routes a scalar override to the member of its primitive type', () => {
    const fixture = createFixture(S.Struct({ value: S.Union(S.String, S.Number) }));

    expect(fixture({ value: 5 }).value).toBe(5);
    expect(fixture({ value: 'five' }).value).toBe('five');
  });
});

describe('optionalWith and property defaults', () => {
  it('leaves a field with a decode-side default off the wire', () => {
    const Entity = S.Struct({
      retries: S.optionalWith(S.Number, { default: () => 3 }),
      name: S.String,
    });

    const value = createFixture(Entity)();

    // The wire payload omits it; decoding fills it in. Both facts checked.
    expect(value).not.toHaveProperty('retries');
    expect(S.decodeUnknownSync(Entity)(value).retries).toBe(3);
  });

  it('still accepts an override for it', () => {
    const Entity = S.Struct({
      retries: S.optionalWith(S.Number, { default: () => 3 }),
      name: S.String,
    });

    expect(createFixture(Entity)({ retries: 7 }).retries).toBe(7);
  });
});

describe('tuples', () => {
  it('generates fixed elements and omits optional ones', () => {
    const fixture = createFixture(S.Struct({
      pair: S.Tuple(S.String, S.Number),
      loose: S.Tuple(S.String, S.optionalElement(S.Number)),
    }));

    const value = fixture();

    expect(value.pair).toEqual([expect.any(String), 1]);
    expect(value.loose).toEqual([expect.any(String)]);
  });

  it('includes an optional element the override reaches', () => {
    const fixture = createFixture(S.Struct({
      loose: S.Tuple(S.String, S.optionalElement(S.Number)),
    }));

    expect(fixture({ loose: ['a', 9] }).loose).toEqual(['a', 9]);
  });
});

describe('other shapes', () => {
  it('generates template literals', () => {
    const fixture = createFixture(S.Struct({
      slug: S.TemplateLiteral('user-', S.Number),
    }));

    expect(fixture().slug).toMatch(/^user-\d+/);
  });

  it('passes branded schemas through transparently', () => {
    const OrderId = S.String.pipe(S.brand('OrderId'));
    const fixture = createFixture(S.Struct({ id: OrderId }));

    expect(fixture().id).toEqual(expect.any(String));
  });

  it('generates symbol-keyed properties', () => {
    const key = Symbol.for('effect-fixtures/test');
    const fixture = createFixture(S.Struct({ [key]: S.String, plain: S.Number }));

    const value = fixture();

    expect(value[key]).toEqual(expect.any(String));
    expect(value.plain).toBe(1);
  });

  it('generates records with number-like keys through overrides', () => {
    const fixture = createFixture(S.Struct({
      scores: S.Record({ key: S.String, value: S.Number }),
    }));

    expect(fixture({ scores: { alpha: 10, beta: GENERATE } }).scores)
      .toEqual({ alpha: 10, beta: 1 });
  });

  it('handles deeply nested composition in one build', () => {
    const Deep = S.Struct({
      teams: S.Array(S.Struct({
        name: S.String,
        members: S.Array(S.Struct({
          id: S.UUID,
          role: S.Literal('admin', 'member'),
          joined: S.Date,
        })).pipe(S.minItems(1)),
      })).pipe(S.minItems(2)),
    });

    const value = createFixture(Deep)();

    expect(value.teams).toHaveLength(2);
    expect(value.teams[0]?.members).toHaveLength(1);
    expect(value.teams[0]?.members[0]?.role).toBe('admin');
  });
});
