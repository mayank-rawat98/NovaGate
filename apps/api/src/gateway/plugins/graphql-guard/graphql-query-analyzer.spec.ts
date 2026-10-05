import { analyzeQuery } from './graphql-query-analyzer';

describe('GraphQL AST resource analysis', () => {
  it('counts field nesting and depth-weighted fields exactly', () => {
    expect(analyzeQuery('{ users { id name } }')).toMatchObject({
      depth: 2,
      complexity: 5,
      hasIntrospection: false,
      operation: 'query',
    });
    expect(analyzeQuery('{ a { b { c { d } } } }')).toMatchObject({
      depth: 4,
      complexity: 10,
    });
  });
  it('expands fragment depth at every insertion point', () => {
    const query =
      '{ root { ...F0 } } ' +
      Array.from(
        { length: 12 },
        (_, i) =>
          `fragment F${i} on Node { child { ${i === 11 ? 'value' : `...F${i + 1}`} } }`,
      ).join(' ');
    expect(analyzeQuery(query, { maxDepth: 100 })).toMatchObject({
      depth: 14,
      complexity: 105,
    });
    expect(analyzeQuery(query).depth).toBe(11); // Saturated exceeded sentinel.
  });
  it('counts aliases and inline fragments without inventing type-condition depth', () => {
    expect(
      analyzeQuery(
        '{ one: user { ... on User { id name } } two: user { id } }',
      ),
    ).toMatchObject({ depth: 2, complexity: 8 });
  });
  it('bounds exponentially repeated fragment expansion with DAG summaries', () => {
    const query =
      '{ ...F0 } ' +
      Array.from(
        { length: 64 },
        (_, i) =>
          `fragment F${i} on Query { ${i === 63 ? 'value' : `...F${i + 1} ...F${i + 1}`} }`,
      ).join(' ');
    expect(analyzeQuery(query).complexity).toBe(1001);
  });
  it.each([
    '{ ...Unknown }',
    '{ ...A } fragment A on Query { ...A }',
    '{ ...A } fragment A on Query { ...B } fragment B on Query { ...A }',
    '{ a } fragment A on Query { a } fragment A on Query { b }',
  ])('rejects missing, cyclic or duplicate fragments: %s', (query) => {
    expect(() => analyzeQuery(query)).toThrow();
  });
  it('selects the named operation and only its reachable introspection fields', () => {
    const query =
      'query Normal { __typename } query Introspection { hidden: __schema { types { name } } }';
    expect(() => analyzeQuery(query)).toThrow();
    expect(
      analyzeQuery(query, { operationName: 'Normal' }).hasIntrospection,
    ).toBe(false);
    expect(
      analyzeQuery(query, { operationName: 'Introspection' }).hasIntrospection,
    ).toBe(true);
    expect(() => analyzeQuery(query, { operationName: 'Missing' })).toThrow();
  });
  it.each([
    '',
    '{',
    '{ a } mutation { b }',
    'query Same { a } query Same { b }',
    'type Query { value: String }',
  ])('rejects malformed or ambiguous executable documents: %s', (query) => {
    expect(() => analyzeQuery(query)).toThrow();
  });
  it('ignores introspection-like aliases, argument strings, comments and block strings', () => {
    const query = String.raw`{ __schema: user(filter: {value: "__type"}, text: "he said \"hello\"") { __typename id } } # __schema`;
    expect(analyzeQuery(query)).toMatchObject({
      depth: 2,
      complexity: 5,
      hasIntrospection: false,
    });
    expect(
      analyzeQuery('{ user(text: """ { __schema } """) { id } }')
        .hasIntrospection,
    ).toBe(false);
  });
  it('blocks actual introspection hidden in reachable fragments', () => {
    expect(
      analyzeQuery(
        '{ ...A } fragment A on Query { hidden: __type(name: "User") { name } }',
      ).hasIntrospection,
    ).toBe(true);
  });
  it('conservatively counts fields behind variable-dependent directives', () => {
    expect(
      analyzeQuery('query Q($skip: Boolean!) { user @skip(if: $skip) { id } }'),
    ).toMatchObject({ depth: 2, complexity: 3 });
  });
  it('counts valid fields whose names are GraphQL keywords', () => {
    expect(
      analyzeQuery(
        '{ query mutation subscription fragment on true false null }',
      ).complexity,
    ).toBe(8);
  });
  it('enforces lexical nesting, token and byte limits before recursive parsing', () => {
    expect(() =>
      analyzeQuery('{ a { b { c } } }', { maxLexicalDepth: 2 }),
    ).toThrow();
    expect(() => analyzeQuery('{ a b c d e }', { maxTokens: 3 })).toThrow();
    expect(() => analyzeQuery('{ hello }', { maxQueryBytes: 3 })).toThrow();
    const deepArgument =
      '{ value(arg: ' + '['.repeat(2000) + '1' + ']'.repeat(2000) + ') }';
    expect(() => analyzeQuery(deepArgument)).toThrow();
  });
});
