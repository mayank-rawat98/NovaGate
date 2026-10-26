import { Kind, Lexer, Source, TokenKind, parse } from 'graphql';
import type { OperationDefinitionNode, SelectionSetNode } from 'graphql';
import {
  DEFAULT_GRAPHQL,
  GraphqlSettings,
} from '../../../config/configuration';

export interface QueryAnalysis {
  depth: number;
  complexity: number;
  hasIntrospection: boolean;
  operation: 'query' | 'mutation' | 'subscription';
}
export class GraphqlAnalysisError extends Error {
  constructor(readonly code = 'GRAPHQL_QUERY_INVALID') {
    super('Invalid GraphQL request');
  }
}
interface Summary {
  depth: number;
  count: number;
  weight: number;
  introspection: boolean;
}

/** Schema-free, conservative field-depth cost. DAG summaries account for every
 * spread without allocating or walking its exponentially expanded selections. */
export function analyzeQuery(
  query: string,
  options: Partial<GraphqlSettings> & { operationName?: string } = {},
): QueryAnalysis {
  const limits = { ...DEFAULT_GRAPHQL, ...options };
  if (typeof query !== 'string' || !query.trim())
    throw new GraphqlAnalysisError();
  if (Buffer.byteLength(query) > limits.maxQueryBytes)
    throw new GraphqlAnalysisError('GRAPHQL_QUERY_LIMIT_EXCEEDED');
  const source = new Source(query);
  const lexer = new Lexer(source);
  let nesting = 0,
    tokens = 0;
  try {
    for (
      let token = lexer.advance();
      token.kind !== TokenKind.EOF;
      token = lexer.advance()
    ) {
      if (++tokens > limits.maxTokens)
        throw new GraphqlAnalysisError('GRAPHQL_QUERY_LIMIT_EXCEEDED');
      if (
        [TokenKind.BRACE_L, TokenKind.PAREN_L, TokenKind.BRACKET_L].includes(
          token.kind as typeof TokenKind.BRACE_L,
        )
      ) {
        if (++nesting > limits.maxLexicalDepth)
          throw new GraphqlAnalysisError('GRAPHQL_QUERY_LIMIT_EXCEEDED');
      } else if (
        [TokenKind.BRACE_R, TokenKind.PAREN_R, TokenKind.BRACKET_R].includes(
          token.kind as typeof TokenKind.BRACE_R,
        )
      )
        nesting--;
    }
  } catch (error) {
    throw error instanceof GraphqlAnalysisError
      ? error
      : new GraphqlAnalysisError();
  }
  let document;
  try {
    document = parse(source, { noLocation: true, maxTokens: limits.maxTokens });
  } catch {
    throw new GraphqlAnalysisError();
  }
  const fragments = new Map<string, SelectionSetNode>();
  const operations: OperationDefinitionNode[] = [];
  const names = new Set<string>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      const name = definition.name.value;
      if (fragments.has(name)) throw new GraphqlAnalysisError();
      fragments.set(name, definition.selectionSet);
    } else if (definition.kind === Kind.OPERATION_DEFINITION) {
      if (definition.name) {
        if (names.has(definition.name.value)) throw new GraphqlAnalysisError();
        names.add(definition.name.value);
      }
      operations.push(definition);
    } else throw new GraphqlAnalysisError();
  }
  if (
    !operations.length ||
    (operations.length > 1 && operations.some((op) => !op.name))
  )
    throw new GraphqlAnalysisError();
  const selected =
    options.operationName === undefined
      ? operations.length === 1
        ? operations[0]
        : undefined
      : operations.find((op) => op.name?.value === options.operationName);
  if (!selected) throw new GraphqlAnalysisError('GRAPHQL_OPERATION_INVALID');

  const dependencies = (set: SelectionSetNode): Set<string> => {
    const result = new Set<string>();
    const stack = [set];
    while (stack.length) {
      const current = stack.pop();
      if (!current) break;
      for (const selection of current.selections) {
        if (selection.kind === Kind.FRAGMENT_SPREAD) {
          if (!fragments.has(selection.name.value))
            throw new GraphqlAnalysisError();
          result.add(selection.name.value);
        } else if (selection.selectionSet) stack.push(selection.selectionSet);
      }
    }
    return result;
  };
  const remaining = new Map<string, number>();
  const parents = new Map<string, Set<string>>();
  const ready: string[] = [];
  for (const [name, set] of fragments) {
    const deps = dependencies(set);
    remaining.set(name, deps.size);
    if (!deps.size) ready.push(name);
    for (const dep of deps) {
      const values = parents.get(dep) ?? new Set<string>();
      values.add(name);
      parents.set(dep, values);
    }
  }
  for (const op of operations) dependencies(op.selectionSet);
  const summaries = new Map<string, Summary>();
  const cap = limits.maxComplexity + 1;
  const add = (a: number, b: number) => Math.min(cap, a + b);
  const summarize = (set: SelectionSetNode): Summary => {
    // Explicit post-order frames avoid call-stack exhaustion for nested selections.
    const frames: Array<{
      set: SelectionSetNode;
      index: number;
      viaField: boolean;
      value: Summary;
    }> = [
      {
        set,
        index: 0,
        viaField: false,
        value: { depth: 0, count: 0, weight: 0, introspection: false },
      },
    ];
    let output: Summary = {
      depth: 0,
      count: 0,
      weight: 0,
      introspection: false,
    };
    const merge = (target: Summary, value: Summary, viaField: boolean) => {
      target.depth = Math.max(
        target.depth,
        Math.min(limits.maxDepth + 1, value.depth + Number(viaField)),
      );
      target.count = add(target.count, value.count);
      target.weight = add(
        target.weight,
        add(value.weight, viaField ? value.count : 0),
      );
      target.introspection ||= value.introspection;
    };
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const selection = frame.set.selections[frame.index++];
      if (!selection) {
        frames.pop();
        if (frames.length)
          merge(frames[frames.length - 1].value, frame.value, frame.viaField);
        else output = frame.value;
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const summary = summaries.get(selection.name.value);
        if (!summary) throw new GraphqlAnalysisError();
        merge(frame.value, summary, false);
      } else {
        const field = selection.kind === Kind.FIELD;
        if (field) {
          frame.value.count = add(frame.value.count, 1);
          frame.value.weight = add(frame.value.weight, 1);
          frame.value.depth = Math.max(frame.value.depth, 1);
          frame.value.introspection ||=
            selection.name.value === '__schema' ||
            selection.name.value === '__type';
        }
        if (selection.selectionSet)
          frames.push({
            set: selection.selectionSet,
            index: 0,
            viaField: field,
            value: { depth: 0, count: 0, weight: 0, introspection: false },
          });
      }
    }
    return output;
  };
  for (let index = 0; index < ready.length; index++) {
    const name = ready[index];
    const set = fragments.get(name);
    if (!set) throw new GraphqlAnalysisError();
    summaries.set(name, summarize(set));
    for (const parent of parents.get(name) ?? []) {
      const count = (remaining.get(parent) ?? 0) - 1;
      remaining.set(parent, count);
      if (!count) ready.push(parent);
    }
  }
  if (summaries.size !== fragments.size)
    throw new GraphqlAnalysisError('GRAPHQL_FRAGMENT_CYCLE');
  const result = summarize(selected.selectionSet);
  return {
    depth: result.depth,
    complexity: result.weight,
    hasIntrospection: result.introspection,
    operation: selected.operation,
  };
}
