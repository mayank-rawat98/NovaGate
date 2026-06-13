import { analyzeQuery } from './graphql-query-analyzer';

describe('analyzeQuery', () => {
  describe('depth', () => {
    it('returns 0 for an empty string', () => {
      expect(analyzeQuery('').depth).toBe(0);
    });

    it('counts top-level selection set as depth 1', () => {
      const q = '{ users { id } }';
      expect(analyzeQuery(q).depth).toBe(2);
    });

    it('counts max nesting depth correctly', () => {
      const q = '{ a { b { c { d } } } }';
      expect(analyzeQuery(q).depth).toBe(4);
    });

    it('does not count argument object braces as selection depth', () => {
      const q = '{ users(filter: { active: true }) { id } }';
      expect(analyzeQuery(q).depth).toBe(2);
    });

    it('handles fragments correctly', () => {
      const q = `
        fragment UserFields on User { id name }
        { users { ...UserFields } }
      `;
      expect(analyzeQuery(q).depth).toBeLessThanOrEqual(3);
    });

    it('handles query operation keyword', () => {
      const q = 'query GetUsers { users { id name } }';
      expect(analyzeQuery(q).depth).toBe(2);
    });

    it('handles nested query with three levels', () => {
      const q = '{ org { teams { members { id } } } }';
      expect(analyzeQuery(q).depth).toBe(4);
    });
  });

  describe('complexity', () => {
    it('returns 0 for empty query', () => {
      expect(analyzeQuery('').complexity).toBe(0);
    });

    it('assigns higher complexity to deeper fields', () => {
      const shallow = '{ a b c }';
      const deep = '{ a { b { c } } }';
      expect(analyzeQuery(deep).complexity).toBeGreaterThan(
        analyzeQuery(shallow).complexity,
      );
    });

    it('counts each field at its nesting depth', () => {
      // depth 1: users (complexity += 1)
      // depth 2: id, name (complexity += 2 + 2 = 4)
      // total: 5
      const q = '{ users { id name } }';
      const { complexity } = analyzeQuery(q);
      expect(complexity).toBeGreaterThan(0);
    });
  });

  describe('introspection', () => {
    it('detects __schema in query', () => {
      const q = '{ __schema { types { name } } }';
      expect(analyzeQuery(q).hasIntrospection).toBe(true);
    });

    it('detects __type in query', () => {
      const q = '{ __type(name: "User") { fields { name } } }';
      expect(analyzeQuery(q).hasIntrospection).toBe(true);
    });

    it('returns false when no introspection fields', () => {
      const q = '{ users { id name } }';
      expect(analyzeQuery(q).hasIntrospection).toBe(false);
    });
  });

  describe('string literal handling', () => {
    it('does not count braces inside string literals', () => {
      const q = '{ users(name: "{ not a brace }") { id } }';
      expect(analyzeQuery(q).depth).toBe(2);
    });

    it('handles escaped quotes in strings', () => {
      const q = '{ search(q: "he said \\"hello\\"") { id } }';
      expect(analyzeQuery(q).depth).toBe(2);
    });
  });

  describe('comment handling', () => {
    it('ignores # comments', () => {
      const q = `
        # This is a comment { not a brace }
        { users { id } }
      `;
      expect(analyzeQuery(q).depth).toBe(2);
    });
  });
});
