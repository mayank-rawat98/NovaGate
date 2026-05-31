export interface QueryAnalysis {
  depth: number;
  complexity: number;
  hasIntrospection: boolean;
}

// GraphQL keywords that are not field names
const KEYWORDS = new Set([
  'query',
  'mutation',
  'subscription',
  'fragment',
  'on',
  'true',
  'false',
  'null',
]);

/**
 * Lightweight GraphQL query analyzer — no schema required.
 *
 * Counts:
 *   depth        — max nesting level of selection sets (not counting argument objects)
 *   complexity   — sum of (each field's nesting depth), weighted by position
 *   hasIntrospection — whether __schema or __type appear anywhere in the query
 *
 * The parser skips string literals, comments, and argument blocks so that
 * `{` inside those do not inflate the selection depth counter.
 */
export function analyzeQuery(query: string): QueryAnalysis {
  let i = 0;
  let selectionDepth = 0;
  let argDepth = 0; // depth inside (...) argument blocks
  let maxDepth = 0;
  let complexity = 0;
  const n = query.length;

  while (i < n) {
    const ch = query[i];

    // Skip line comments
    if (ch === '#') {
      while (i < n && query[i] !== '\n') i++;
      continue;
    }

    // Skip string literals (including block strings """)
    if (ch === '"') {
      i++;
      if (query[i] === '"' && query[i + 1] === '"') {
        // Block string
        i += 2;
        while (
          i < n &&
          !(query[i] === '"' && query[i + 1] === '"' && query[i + 2] === '"')
        ) {
          i++;
        }
        i += 3;
      } else {
        // Regular string
        while (i < n && query[i] !== '"') {
          if (query[i] === '\\') i++; // skip escape
          i++;
        }
        i++; // closing quote
      }
      continue;
    }

    // Argument depth tracking via parentheses
    if (ch === '(') {
      argDepth++;
      i++;
      continue;
    }
    if (ch === ')') {
      argDepth = Math.max(0, argDepth - 1);
      i++;
      continue;
    }

    // Selection set braces — only count when NOT inside argument blocks
    if (ch === '{') {
      if (argDepth === 0) {
        selectionDepth++;
        maxDepth = Math.max(maxDepth, selectionDepth);
      } else {
        argDepth++; // treat as nested object arg
      }
      i++;
      continue;
    }
    if (ch === '}') {
      if (argDepth > 0) {
        argDepth--;
      } else {
        selectionDepth = Math.max(0, selectionDepth - 1);
      }
      i++;
      continue;
    }

    // Field name identifiers
    if (/[a-zA-Z_]/.test(ch)) {
      let name = '';
      const start = i;
      while (i < n && /[a-zA-Z0-9_]/.test(query[i])) {
        name += query[i++];
      }

      // Skip keywords and directives (@ preceded)
      const prevChar = getPrevNonWhitespace(query, start);
      if (prevChar === '@') {
        // This is a directive name, not a field
        continue;
      }

      if (KEYWORDS.has(name)) {
        continue;
      }

      if (argDepth > 0) {
        // Argument key — not a selection field
        continue;
      }

      // Check for alias (name:) — the alias itself is not a field
      const nextChar = getNextNonWhitespace(query, i);
      if (nextChar === ':') {
        // This is an alias; the actual field name follows the colon
        continue;
      }

      // It's a field name at the current selection depth
      complexity += Math.max(1, selectionDepth);
      continue;
    }

    i++;
  }

  const hasIntrospection =
    query.includes('__schema') || query.includes('__type');

  return { depth: maxDepth, complexity, hasIntrospection };
}

function getPrevNonWhitespace(str: string, pos: number): string {
  let j = pos - 1;
  while (j >= 0 && /\s/.test(str[j])) j--;
  return j >= 0 ? str[j] : '';
}

function getNextNonWhitespace(str: string, pos: number): string {
  let j = pos;
  while (j < str.length && /\s/.test(str[j])) j++;
  return j < str.length ? str[j] : '';
}
