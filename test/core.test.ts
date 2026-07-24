import { Schema as S } from 'effect';
import { describe, expect, it } from 'vitest';
import { createFixture, GENERATE } from '../src/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('defaults: what a bare call generates', () => {
  it('fills required fields and omits optional ones', () => {
    const fixture = createFixture(S.Struct({
      id: S.UUID,
      name: S.String,
      description: S.optional(S.NullOr(S.String)),
    }));

    const value = fixture();

    expect(value.id).toMatch(UUID_RE);
    expect(value.name).toEqual(expect.any(String));
    expect(value).not.toHaveProperty('description');
  });

  it('generates the inner type of a required NullOr, not null', () => {
    const fixture = createFixture(S.Struct({ country: S.NullOr(S.Union(S.String, S.Null)) }));

    expect(fixture().country).toEqual(expect.any(String));
  });

  it('honours string length bounds', () => {
    const fixture = createFixture(S.Struct({
      short: S.String.pipe(S.maxLength(4)),
      long: S.String.pipe(S.minLength(40)),
    }));

    const value = fixture();

    expect(value.short).toHaveLength(4);
    expect(value.long.length).toBeGreaterThanOrEqual(40);
  });

  it('honours numeric bounds and integrality', () => {
    const fixture = createFixture(S.Struct({
      port: S.Number.pipe(S.int(), S.greaterThanOrEqualTo(1024), S.lessThanOrEqualTo(65535)),
      ratio: S.Number,
    }));

    const value = fixture();

    expect(value.port).toBe(1024);
    expect(Number.isInteger(value.port)).toBe(true);
    expect(value.ratio).toBe(1);
  });

  it('rounds a fractional lower bound up when the value must be an integer', () => {
    const fixture = createFixture(S.Struct({
      n: S.Number.pipe(S.int(), S.greaterThanOrEqualTo(0.5)),
    }));

    expect(fixture().n).toBe(1);
  });

  it('honours multipleOf together with a lower bound', () => {
    const fixture = createFixture(S.Struct({
      n: S.Number.pipe(S.greaterThanOrEqualTo(7), S.multipleOf(5)),
    }));

    expect(fixture().n).toBe(10);
  });

  it('satisfies a pattern refinement when a candidate matches', () => {
    const fixture = createFixture(S.Struct({
      slug: S.String.pipe(S.pattern(/^[a-z][a-z0-9-]*$/)),
    }));

    expect(fixture().slug).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('names the field when no candidate can match the pattern', () => {
    const fixture = createFixture(S.Struct({
      token: S.String.pipe(S.pattern(/^zzz-[0-9]{4}$/)),
    }));

    expect(() => fixture()).toThrow(/token/);
  });

  it('picks the first member of a literal union and of an enum', () => {
    enum Purpose { Main = 'main', Backup = 'backup' }

    const fixture = createFixture(S.Struct({
      kind: S.Literal('primary', 'secondary'),
      purpose: S.Enums(Purpose),
    }));

    expect(fixture()).toEqual({ kind: 'primary', purpose: 'main' });
  });

  it('defaults an unconstrained array to empty and respects minItems', () => {
    const fixture = createFixture(S.Struct({
      tags: S.Array(S.String),
      pair: S.Array(S.String).pipe(S.minItems(2)),
    }));

    const value = fixture();

    expect(value.tags).toEqual([]);
    expect(value.pair).toHaveLength(2);
  });

  it('defaults a Record to empty', () => {
    const fixture = createFixture(S.Struct({
      metadata: S.Record({ key: S.String, value: S.String }),
    }));

    expect(fixture().metadata).toEqual({});
  });

  it('recurses into a nested struct', () => {
    const fixture = createFixture(S.Struct({
      plan: S.Struct({ tier: S.String, seats: S.Number }),
    }));

    expect(fixture().plan).toEqual({ tier: expect.any(String), seats: 1 });
  });

  it('reads the fields a struct spreads in', () => {
    const Flags = S.Struct({ archived: S.Boolean });
    const fixture = createFixture(S.Struct({ name: S.String, ...Flags.fields }));

    expect(fixture()).toHaveProperty('archived', false);
  });

  it('prefers a `default` annotation over a generated value', () => {
    const fixture = createFixture(S.Struct({
      region: S.String.annotations({ default: 'eu-west-1' }),
      locale: S.String.annotations({ examples: ['en-GB'] }),
    }));

    expect(fixture()).toEqual({ region: 'eu-west-1', locale: 'en-GB' });
  });

  it('fills optional fields when includeOptional is set', () => {
    const fixture = createFixture(S.Struct({
      name: S.String,
      note: S.optional(S.String),
    }), { includeOptional: true });

    expect(fixture().note).toEqual(expect.any(String));
  });
});

describe('overrides', () => {
  const Project = S.Struct({
    id: S.UUID,
    name: S.String,
    enabled: S.Boolean,
    description: S.optional(S.NullOr(S.String)),
    plan: S.Struct({ tier: S.String, seats: S.Number }),
    metadata: S.optional(S.NullOr(S.Record({ key: S.String, value: S.String }))),
    members: S.Array(S.Struct({ email: S.String, admin: S.Boolean })),
  });

  it('replaces the generated value of a required field', () => {
    expect(createFixture(Project)({ name: 'Acme' }).name).toBe('Acme');
  });

  it('opts an optional field in', () => {
    expect(createFixture(Project)({ description: 'a note' }).description).toBe('a note');
  });

  it('keeps an optional field omitted when it is not overridden', () => {
    expect(createFixture(Project)({ name: 'Acme' })).not.toHaveProperty('description');
  });

  it('sends an explicit null when the override is null', () => {
    expect(createFixture(Project)({ description: null }).description).toBeNull();
  });

  it('merges into a nested struct, generating the siblings it did not mention', () => {
    expect(createFixture(Project)({ plan: { tier: 'trial' } }).plan)
      .toEqual({ tier: 'trial', seats: 1 });
  });

  it('fills Record entries from the keys the override supplies', () => {
    expect(createFixture(Project)({ metadata: { team: 'platform' } }).metadata)
      .toEqual({ team: 'platform' });
  });

  it('sizes an array from the override and generates each element through the schema', () => {
    expect(createFixture(Project)({ members: [{ email: 'a@b.c' }, {}] }).members).toEqual([
      { email: 'a@b.c', admin: false },
      { email: expect.any(String), admin: false },
    ]);
  });

  it('opts an optional field in with a generated value via GENERATE', () => {
    expect(createFixture(Project)({ description: GENERATE }).description)
      .toEqual(expect.any(String));
  });

  it('reaches a nested optional with GENERATE', () => {
    const fixture = createFixture(S.Struct({
      plan: S.Struct({ tier: S.String, renews_at: S.optional(S.String) }),
    }));

    expect(fixture({ plan: { renews_at: GENERATE } }).plan.renews_at)
      .toEqual(expect.any(String));
  });

  it('applies builder defaults, and lets a per-call override beat them', () => {
    const fixture = createFixture(Project, {
      defaults: { enabled: true, plan: { tier: 'standard' } },
    });

    expect(fixture().enabled).toBe(true);
    expect(fixture().plan.tier).toBe('standard');
    expect(fixture({ enabled: false }).enabled).toBe(false);
    expect(fixture({ plan: { tier: 'trial' } }).plan).toEqual({ tier: 'trial', seats: 1 });
  });
});

describe('generators', () => {
  const IsoDate = S.String.annotations({ identifier: 'IsoDate' });

  const Entity = S.Struct({
    name: S.String,
    created_at: IsoDate,
    expires_at: IsoDate,
    plan: S.Struct({ tier: S.String }),
  });

  it('resolves a generator by identifier annotation, covering every occurrence', () => {
    const fixture = createFixture(Entity, {
      generators: { IsoDate: () => '2026-01-01T00:00:00Z' },
    });

    const value = fixture();

    expect(value.created_at).toBe('2026-01-01T00:00:00Z');
    expect(value.expires_at).toBe('2026-01-01T00:00:00Z');
  });

  it('prefers path over field over identifier', () => {
    const fixture = createFixture(Entity, {
      generators: {
        IsoDate: () => 'by-identifier',
        expires_at: () => 'by-field',
        'plan.tier': () => 'by-path',
      },
    });

    const value = fixture();

    expect(value.created_at).toBe('by-identifier');
    expect(value.expires_at).toBe('by-field');
    expect(value.plan.tier).toBe('by-path');
  });

  it('passes the field context to the generator', () => {
    const seen: string[] = [];
    createFixture(Entity, {
      seed: 'fixed',
      generators: {
        IsoDate: (ctx) => {
          seen.push(`${ctx.path}:${ctx.identifier}:${ctx.token}`);
          return 'x';
        },
      },
    })();

    expect(seen).toEqual(['created_at:IsoDate:fixed', 'expires_at:IsoDate:fixed']);
  });

  it('does not call a generator for a field the caller overrode', () => {
    const fixture = createFixture(Entity, {
      generators: {
        IsoDate: () => {
          throw new Error('should not run');
        },
      },
    });

    expect(() => fixture({ created_at: 'x', expires_at: 'y' })).not.toThrow();
  });

  it('still runs the registered generator for a GENERATE field', () => {
    const fixture = createFixture(S.Struct({
      note: S.optional(S.String),
    }), { generators: { note: () => 'from generator' } });

    expect(fixture({ note: GENERATE }).note).toBe('from generator');
  });
});

describe('uniqueness and determinism', () => {
  const Entity = S.Struct({ id: S.UUID, name: S.String });

  it('generates different values on every build, so reruns do not collide', () => {
    const fixture = createFixture(Entity);

    expect(fixture().name).not.toBe(fixture().name);
    expect(fixture().id).not.toBe(fixture().id);
  });

  it('repeats itself byte-for-byte when seeded, UUIDs included', () => {
    const fixture = createFixture(Entity, { seed: 'fixed' });

    const first = fixture();
    const second = fixture();

    expect(first).toEqual(second);
    expect(first.name).toBe('name-fixed');
    expect(first.id).toMatch(UUID_RE);
  });

  it('different seeds give different UUIDs', () => {
    const a = createFixture(Entity, { seed: 'a' })();
    const b = createFixture(Entity, { seed: 'b' })();

    expect(a.id).not.toBe(b.id);
  });
});

describe('validation', () => {
  const Entity = S.Struct({
    name: S.String.pipe(S.minLength(3)),
    port: S.Number.pipe(S.int()),
  });

  it('rejects an override the schema would reject, naming the field', () => {
    expect(() => createFixture(Entity)({ name: 'ab' })).toThrow(/name/);
  });

  it('rejects an override of the wrong type', () => {
    // @ts-expect-error -- the point of the test: the type error is also caught at runtime.
    expect(() => createFixture(Entity)({ port: 'not a number' })).toThrow(/port/);
  });

  it('lets `raw` through for negative tests', () => {
    expect(createFixture(Entity).raw({ name: 'ab' })).toEqual({ name: 'ab', port: 1 });
  });
});

describe('shapes it cannot generate', () => {
  it('explains an opaque declaration instead of emitting something invalid', () => {
    const fixture = createFixture(S.Struct({ opt: S.OptionFromSelf(S.String) }));

    expect(() => fixture()).toThrow(/opt/);
  });

  it('terminates on a recursive schema whose recursion sits behind an array', () => {
    interface Category {
      readonly name: string;
      readonly children: ReadonlyArray<Category>;
    }

    const Category: S.Schema<Category> = S.suspend(
      () => S.Struct({ name: S.String, children: S.Array(Category) }),
    );

    expect(createFixture(S.Struct({ root: Category }))().root).toEqual({
      name: expect.any(String),
      children: [],
    });
  });

  it('reports unbounded recursion instead of overflowing the stack', () => {
    interface Chain { readonly next: Chain; }

    const Chain: S.Schema<Chain> = S.suspend(() => S.Struct({ next: Chain }));

    expect(() => createFixture(S.Struct({ start: Chain }), { maxDepth: 5 })())
      .toThrow(/recurses past 5 levels/);
  });
});
