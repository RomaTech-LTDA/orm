/**
 * @module query-expression
 * @description Defines the type vocabulary for structured query objects and implements
 * the predicate/selector parser that converts JavaScript arrow functions into
 * database-portable {@link QueryExpression} trees.
 *
 * ## Parser algorithm overview
 *
 * `parsePredicate` and `parseSelector` work by inspecting the **source text** of
 * the supplied arrow function (via `Function.prototype.toString()`).  The parser
 * does **not** execute the function — it analyses the string representation.
 *
 * Steps:
 * 1. Extract the expression body after `=>` (or the `return` value of a block body).
 * 2. Recursively split the expression on top-level `||` / `&&` to build a
 *    {@link QueryExpression} logical tree.
 * 3. For leaf nodes, recognise:
 *    - Binary comparisons:  `entity.field === value`
 *    - String helpers:       `entity.field.includes('x')`, `.startsWith`, `.endsWith`
 *      → translated to SQL `LIKE` patterns.
 *    - Boolean members:      `entity.isActive` / `!entity.isActive`
 * 4. Unrecognised expressions cause the function to return `undefined`, signalling
 *    that client-side filtering must be used as a fallback.
 */

// ---------------------------------------------------------------------------
// Core type aliases
// ---------------------------------------------------------------------------

/**
 * A predicate function that tests a single entity instance.
 * Used by `where()` and aggregate methods such as `any()`, `count()`, `all()`.
 *
 * @template T - Entity type being filtered.
 *
 * @example
 * ```ts
 * const active: QueryPredicate<User> = u => u.isActive && u.age >= 18;
 * ```
 */
export type QueryPredicate<T> = (entity: T) => boolean;

/**
 * A projection function that maps an entity to a (possibly different) shape.
 * Used by `select()` to determine which fields to return.
 *
 * @template T       - Source entity type.
 * @template TResult - Target projection type (defaults to `any`).
 *
 * @example
 * ```ts
 * const selector: QuerySelector<User, string> = u => u.name;
 * ```
 */
export type QuerySelector<T, TResult = any> = (entity: T) => TResult;

/**
 * Sort direction for `orderBy` / `orderByDescending` operations.
 */
export type QueryOrderDirection = 'asc' | 'desc';

/**
 * SQL comparison operators supported by the predicate parser.
 * `like` and `notLike` are generated automatically from `.includes()`,
 * `.startsWith()`, and `.endsWith()` string method calls.
 */
export type QueryComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'like' | 'notLike';

/**
 * Logical operators used to combine multiple {@link QueryExpression} nodes.
 */
export type QueryLogicalOperator = 'and' | 'or';

// ---------------------------------------------------------------------------
// Expression tree types
// ---------------------------------------------------------------------------

/**
 * A discriminated union that represents either:
 * - a leaf **comparison** (`field operator value`), or
 * - a **logical** grouping of child expressions joined by `AND` / `OR`.
 *
 * The tree is built by {@link parsePredicate} and consumed by the SQL builder
 * in {@link buildSelectSql} to generate a `WHERE` clause.
 *
 * @example Leaf comparison
 * ```ts
 * const expr: QueryExpression = { kind: 'comparison', field: 'age', operator: '>=', value: 18 };
 * ```
 *
 * @example Logical group
 * ```ts
 * const expr: QueryExpression = {
 *   kind: 'logical',
 *   operator: 'and',
 *   expressions: [
 *     { kind: 'comparison', field: 'isActive', operator: '=', value: true },
 *     { kind: 'comparison', field: 'age', operator: '>=', value: 18 },
 *   ]
 * };
 * ```
 */
export type QueryExpression =
    | {
        kind: 'comparison';
        /** The entity property name that maps to a database column. */
        field: string;
        /** The comparison operator to apply. */
        operator: QueryComparisonOperator;
        /** The literal value to compare against. */
        value: unknown;
      }
    | {
        kind: 'logical';
        /** Logical operator joining child expressions. */
        operator: QueryLogicalOperator;
        /** Child expressions in this logical group. */
        expressions: QueryExpression[];
      };

/**
 * Describes a single `ORDER BY` column used in server-side SQL generation.
 */
export interface QueryOrderExpression {
    /** Column name to sort by. */
    field: string;
    /** Sort direction. */
    direction: QueryOrderDirection;
}

/**
 * Describes the columns projected by a `SELECT` clause.
 *
 * - `field` — a single column projection (e.g. `SELECT name FROM …`).
 * - `fields` — a multi-column projection (e.g. `SELECT id, name FROM …`).
 */
export interface QueryProjectionExpression {
    /** Single projected field name. */
    field?: string;
    /** Multiple projected field names. */
    fields?: string[];
}

/**
 * Pairs a selector function with its sort direction for use in the
 * client-side sort comparer built by {@link QueryBuilder}.
 *
 * @template T - Entity type.
 */
export interface QueryOrdering<T> {
    /** Selector that extracts the sort key from an entity. */
    selector: QuerySelector<T>;
    /** Sort direction. */
    direction: QueryOrderDirection;
}

/**
 * The complete, immutable description of a query that is handed to a provider's
 * `executeQuery` implementation.
 *
 * Providers that support server-side SQL should consume `whereExpressions` and
 * `orderByExpressions` to build an optimised query, then fall back to
 * `applyClientSideQuery` for any parts that cannot be pushed to the database.
 *
 * @template T       - Source entity type.
 * @template TResult - Projected result type (defaults to `any`).
 */
export interface QueryObject<T, TResult = any> {
    /** Navigation properties to eager-load (e.g. `['orders', 'orders.items']`). */
    includes: string[];

    /** Original predicate functions (used for client-side filtering fallback). */
    predicates: QueryPredicate<T>[];

    /**
     * Parsed expression trees derived from `predicates`.
     * A 1-to-1 correspondence with `predicates` is maintained so providers can
     * detect whether every predicate was successfully parsed.
     */
    whereExpressions: QueryExpression[];

    /** Original ordering descriptors (used for client-side sort fallback). */
    orderings: QueryOrdering<T>[];

    /**
     * Parsed order descriptors derived from `orderings`.
     * Same length as `orderings` when all selectors were successfully parsed.
     */
    orderByExpressions: QueryOrderExpression[];

    /** Optional selector function for client-side projection. */
    selector?: QuerySelector<T, TResult>;

    /** Parsed projection descriptor for server-side `SELECT` column lists. */
    projection?: QueryProjectionExpression;

    /** Number of rows to skip (maps to `OFFSET`). */
    skip?: number;

    /** Maximum number of rows to return (maps to `LIMIT` / `TOP` / `FETCH NEXT`). */
    take?: number;

    /**
     * Backward-compatible fields used by older providers. New providers should
     * prefer predicates/orderings and the parsed expression arrays.
     */
    where?: QueryPredicate<T>;

    /**
     * Composite comparer function derived from `orderings`.
     * Pre-built by {@link QueryBuilder} for use by providers that sort
     * client-side.
     */
    orderBy?: (a: T, b: T) => number;
}

// ---------------------------------------------------------------------------
// Public parsing helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to parse an arrow-function predicate into a portable
 * {@link QueryExpression} tree.
 *
 * The expression tree can be translated to SQL by providers that support
 * server-side filtering.  When parsing fails (e.g. the predicate uses
 * variables from the outer scope or unsupported patterns) the function returns
 * `undefined` and the provider must evaluate the predicate on the client.
 *
 * @param predicate - Arrow function predicate, e.g. `u => u.age > 18`.
 * @returns A {@link QueryExpression} node, or `undefined` if the expression
 *   cannot be represented as a portable query.
 *
 * @example
 * ```ts
 * const expr = parsePredicate<User>(u => u.age >= 18 && u.isActive);
 * // => { kind: 'logical', operator: 'and', expressions: [
 * //      { kind: 'comparison', field: 'age', operator: '>=', value: 18 },
 * //      { kind: 'comparison', field: 'isActive', operator: '=', value: true }
 * //    ] }
 * ```
 */
export function parsePredicate<T>(predicate: QueryPredicate<T>): QueryExpression | undefined {
    const expression = getFunctionExpression(predicate);
    return expression ? parseBooleanExpression(expression, getParameterName(predicate)) : undefined;
}

/**
 * Attempts to parse a selector function into a {@link QueryProjectionExpression}.
 *
 * Supports:
 * - Single member access: `u => u.name` → `{ field: 'name' }`
 * - Object literal projection: `u => ({ id: u.id, name: u.name })` → `{ fields: ['id', 'name'] }`
 *
 * Returns `undefined` when the selector uses expressions the parser cannot
 * represent (e.g. computed values).
 *
 * @param selector - Projection function.
 * @returns A {@link QueryProjectionExpression}, or `undefined`.
 *
 * @example
 * ```ts
 * parseSelector<User>(u => u.name); // { field: 'name' }
 * parseSelector<User>(u => ({ id: u.id, name: u.name })); // { fields: ['id', 'name'] }
 * ```
 */
export function parseSelector<T>(selector: QuerySelector<T>): QueryProjectionExpression | undefined {
    const expression = getFunctionExpression(selector);
    const parameterName = getParameterName(selector);

    if (!expression || !parameterName) {
        return undefined;
    }

    // Try simple member access first (e.g. u => u.name)
    const member = parseMemberExpression(expression, parameterName);
    if (member) {
        return { field: member };
    }

    // Try object literal projection (e.g. u => ({ id: u.id, name: u.name }))
    const objectFields = parseObjectProjection(expression, parameterName);
    return objectFields.length ? { fields: objectFields } : undefined;
}

/**
 * Convenience wrapper that returns only the field name from a single-column
 * selector (used when building `ORDER BY` expressions).
 *
 * @param selector - A selector that returns a single entity property.
 * @returns The property name string, or `undefined` if the selector is complex.
 *
 * @example
 * ```ts
 * getSelectorField<User>(u => u.name); // 'name'
 * getSelectorField<User>(u => u.age);  // 'age'
 * ```
 */
export function getSelectorField<T>(selector: QuerySelector<T>): string | undefined {
    return parseSelector(selector)?.field;
}

// ---------------------------------------------------------------------------
// Internal parsing implementation
// ---------------------------------------------------------------------------

/**
 * Recursively parses a boolean expression string into a {@link QueryExpression}
 * tree.
 *
 * Algorithm:
 * 1. Strip outer parentheses.
 * 2. Try to split on top-level `||` → logical `or` node.
 * 3. Try to split on top-level `&&` → logical `and` node.
 * 4. Try string method patterns (.includes, .startsWith, .endsWith).
 * 5. Try binary comparison (`===`, `!==`, `>`, …).
 * 6. Try bare boolean member / negated member (`entity.flag`, `!entity.flag`).
 */
function parseBooleanExpression(expression: string, parameterName?: string): QueryExpression | undefined {
    const trimmed = stripOuterParens(expression.trim());

    // OR has lower precedence — try splitting on `||` first
    const orParts = splitTopLevel(trimmed, '||');
    if (orParts.length > 1) {
        const expressions = orParts
            .map(part => parseBooleanExpression(part, parameterName))
            .filter((part): part is QueryExpression => part !== undefined);
        // Only promote to a logical node when every part was successfully parsed
        return expressions.length === orParts.length ? { kind: 'logical', operator: 'or', expressions } : undefined;
    }

    // AND
    const andParts = splitTopLevel(trimmed, '&&');
    if (andParts.length > 1) {
        const expressions = andParts
            .map(part => parseBooleanExpression(part, parameterName))
            .filter((part): part is QueryExpression => part !== undefined);
        return expressions.length === andParts.length ? { kind: 'logical', operator: 'and', expressions } : undefined;
    }

    // Leaf-level patterns — ordered by specificity
    return parseStringMethodExpression(trimmed, parameterName)
        || parseComparisonExpression(trimmed, parameterName)
        || parseBooleanMemberExpression(trimmed, parameterName);
}

/**
 * Parses a binary comparison expression such as `entity.age >= 18`.
 *
 * Handles both `left op right` and `right op left` forms, flipping the
 * operator when the literal appears on the left-hand side.
 */
function parseComparisonExpression(expression: string, parameterName?: string): QueryExpression | undefined {
    const match = expression.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
    if (!match) {
        return undefined;
    }

    const [, leftRaw, operatorRaw, rightRaw] = match;
    const left = leftRaw.trim();
    const right = rightRaw.trim();
    const leftField = parseMemberExpression(left, parameterName);
    const rightField = parseMemberExpression(right, parameterName);

    if (leftField && !rightField) {
        const value = parseLiteral(right);
        return value.parsed
            ? { kind: 'comparison', field: leftField, operator: mapOperator(operatorRaw), value: value.value }
            : undefined;
    }

    if (rightField && !leftField) {
        // Flip: `18 < entity.age` → `entity.age > 18`
        const value = parseLiteral(left);
        return value.parsed
            ? { kind: 'comparison', field: rightField, operator: flipOperator(mapOperator(operatorRaw)), value: value.value }
            : undefined;
    }

    return undefined;
}

/**
 * Parses `.includes()`, `.startsWith()`, and `.endsWith()` calls on a member
 * property and converts them to `LIKE` / `NOT LIKE` patterns.
 *
 * Patterns:
 * - `.includes('x')`    → `%x%`
 * - `.startsWith('x')`  → `x%`
 * - `.endsWith('x')`    → `%x`
 *
 * A leading `!` produces a `notLike` operator.
 */
function parseStringMethodExpression(expression: string, parameterName?: string): QueryExpression | undefined {
    const negated = expression.startsWith('!');
    const rawExpression = negated ? expression.slice(1).trim() : expression;
    const match = rawExpression.match(/^(.+?)\.(includes|startsWith|endsWith)\((.+)\)$/);

    if (!match) {
        return undefined;
    }

    const field = parseMemberExpression(match[1].trim(), parameterName);
    const value = parseLiteral(match[3].trim());

    if (!field || !value.parsed || typeof value.value !== 'string') {
        return undefined;
    }

    // Build the LIKE pattern based on the method used
    const pattern = match[2] === 'startsWith'
        ? `${value.value}%`
        : match[2] === 'endsWith'
            ? `%${value.value}`
            : `%${value.value}%`;

    return {
        kind: 'comparison',
        field,
        operator: negated ? 'notLike' : 'like',
        value: pattern
    };
}

/**
 * Parses a bare boolean member access such as `entity.isActive` or
 * its negation `!entity.isActive`.
 *
 * Maps to `field = true` or `field = false` respectively.
 */
function parseBooleanMemberExpression(expression: string, parameterName?: string): QueryExpression | undefined {
    const negated = expression.startsWith('!');
    const memberExpression = negated ? expression.slice(1).trim() : expression;
    const field = parseMemberExpression(memberExpression, parameterName);

    return field
        ? { kind: 'comparison', field, operator: '=', value: !negated }
        : undefined;
}

/**
 * Returns the property access path if `expression` is a member access on the
 * known parameter name (e.g. `u.name`, `u.address.city`), otherwise `undefined`.
 */
function parseMemberExpression(expression: string, parameterName?: string): string | undefined {
    // Build a regex that anchors on the exact parameter name
    const escapedParameter = parameterName ? escapeRegExp(parameterName) : '[A-Za-z_$][\\w$]*';
    const match = expression.match(new RegExp(`^${escapedParameter}\\.([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)$`));
    return match?.[1];
}

/**
 * Extracts field names referenced inside an object-literal projection body
 * such as `({ id: u.id, name: u.name })`.
 *
 * Uses a global regex over the body text — does not parse JS AST — so it
 * correctly handles any ordering of properties.
 */
function parseObjectProjection(expression: string, parameterName: string): string[] {
    const body = stripOuterParens(expression.trim());
    if (!body.startsWith('{') || !body.endsWith('}')) {
        return [];
    }

    const fields = new Set<string>();
    // Match every `param.field` occurrence inside the object literal
    const memberExpression = new RegExp(`${escapeRegExp(parameterName)}\\.([A-Za-z_$][\\w$]*)`, 'g');
    let match: RegExpExecArray | null;

    while ((match = memberExpression.exec(body)) !== null) {
        fields.add(match[1]);
    }

    return Array.from(fields);
}

/**
 * Extracts the expression body from an arrow function or traditional function
 * source string.
 *
 * Handles:
 * - Concise arrow: `u => u.age > 18`
 * - Block arrow:   `u => { return u.age > 18; }`
 * - Traditional:   `function(u) { return u.age > 18; }`
 *
 * @returns The expression string after `=>` or inside the `return` statement,
 *   or `undefined` when the source cannot be parsed.
 */
function getFunctionExpression(fn: Function): string | undefined {
    const source = fn.toString().trim();
    const arrowIndex = source.indexOf('=>');

    if (arrowIndex !== -1) {
        const expression = source.slice(arrowIndex + 2).trim();

        if (expression.startsWith('{')) {
            // Block body — extract the return expression
            const returnMatch = expression.match(/return\s+([\s\S]*?);?\s*}/);
            return returnMatch?.[1]?.trim();
        }

        return expression.trim();
    }

    // Traditional function — look for a return statement
    const returnMatch = source.match(/return\s+([\s\S]*?);?\s*}/);
    return returnMatch?.[1]?.trim();
}

/**
 * Extracts the name of the first parameter from an arrow function or
 * traditional function source string.
 *
 * @returns The parameter name (e.g. `'u'`), or `undefined` if none found.
 */
function getParameterName(fn: Function): string | undefined {
    const source = fn.toString().trim();
    // Match both `u =>` and `(u) =>` (and async variants)
    const arrowMatch = source.match(/^\s*(?:async\s*)?(?:\(?\s*([A-Za-z_$][\w$]*)\s*\)?|\(([^)]*)\))\s*=>/);

    if (arrowMatch) {
        return arrowMatch[1] || arrowMatch[2]?.split(',')[0]?.trim();
    }

    const functionMatch = source.match(/function\s*[^(]*\(\s*([A-Za-z_$][\w$]*)/);
    return functionMatch?.[1];
}

/**
 * Attempts to parse a raw string token as a JavaScript literal value.
 *
 * Supported literals: strings (single/double-quoted), numbers, booleans,
 * `null`, and `undefined`.
 *
 * @returns `{ parsed: true, value }` on success or `{ parsed: false }` when the
 *   token does not represent a static literal.
 */
function parseLiteral(rawValue: string): { parsed: boolean; value?: unknown } {
    const value = rawValue.trim();

    // Quoted string — handles both ' and "
    if (/^(['"])(?:\\.|(?!\1).)*\1$/.test(value)) {
        return { parsed: true, value: value.slice(1, -1).replace(/\\(['"\\])/g, '$1') };
    }

    // Integer or decimal number
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
        return { parsed: true, value: Number(value) };
    }

    if (value === 'true' || value === 'false') {
        return { parsed: true, value: value === 'true' };
    }

    if (value === 'null') {
        return { parsed: true, value: null };
    }

    if (value === 'undefined') {
        return { parsed: true, value: undefined };
    }

    // Outer-scope variable or computed expression — cannot be parsed statically
    return { parsed: false };
}

/**
 * Maps JavaScript comparison operator tokens to {@link QueryComparisonOperator}.
 *
 * `===` and `==` both become `=`; `!==` and `!=` become `!=`.
 */
function mapOperator(operator: string): QueryComparisonOperator {
    switch (operator) {
        case '===':
        case '==':
            return '=';
        case '!==':
        case '!=':
            return '!=';
        default:
            return operator as QueryComparisonOperator;
    }
}

/**
 * Flips a directional comparison operator to its mirror image.
 *
 * Used when a literal appears on the left side of the comparison and the
 * operands are swapped: `18 < entity.age` → operator becomes `>`.
 */
function flipOperator(operator: QueryComparisonOperator): QueryComparisonOperator {
    switch (operator) {
        case '>':  return '<';
        case '>=': return '<=';
        case '<':  return '>';
        case '<=': return '>=';
        default:   return operator;
    }
}

/**
 * Splits `expression` on `operator` while respecting parentheses, brackets,
 * braces, and quoted strings, so that nested expressions are not torn apart.
 *
 * For example, splitting `(a > 0 && b > 0) || c > 0` on `||` yields
 * `['(a > 0 && b > 0)', 'c > 0']`.
 *
 * @returns An array of parts, or the original single-element array when no
 *   top-level match is found.
 */
function splitTopLevel(expression: string, operator: '&&' | '||'): string[] {
    const parts: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: string | undefined;

    for (let i = 0; i < expression.length; i++) {
        const char = expression[i];
        const previous = expression[i - 1];

        // Track open quotes so operators inside strings are ignored
        if (quote) {
            if (char === quote && previous !== '\\') {
                quote = undefined;
            }
            continue;
        }

        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }

        // Track bracket depth so operators inside sub-expressions are ignored
        if (char === '(' || char === '[' || char === '{') depth++;
        if (char === ')' || char === ']' || char === '}') depth--;

        if (depth === 0 && expression.startsWith(operator, i)) {
            parts.push(expression.slice(start, i).trim());
            start = i + operator.length;
            i += operator.length - 1; // advance past the operator characters
        }
    }

    if (parts.length) {
        parts.push(expression.slice(start).trim());
    }

    return parts.length ? parts : [expression];
}

/**
 * Strips one layer of wrapping parentheses from `expression` if, and only if,
 * those parentheses enclose the entire expression (not just a sub-expression).
 *
 * Repeated until no more wrapping parentheses remain.
 */
function stripOuterParens(expression: string): string {
    let current = expression;

    while (current.startsWith('(') && current.endsWith(')') && wrapsWholeExpression(current)) {
        current = current.slice(1, -1).trim();
    }

    return current;
}

/**
 * Returns `true` when the opening `(` at index 0 is matched by the closing `)`
 * at the last position, meaning the entire expression is wrapped.
 *
 * Returns `false` if the depth reaches 0 before the last character (i.e. the
 * outer parens only wrap a prefix of the expression).
 */
function wrapsWholeExpression(expression: string): boolean {
    let depth = 0;
    let quote: string | undefined;

    for (let i = 0; i < expression.length; i++) {
        const char = expression[i];
        const previous = expression[i - 1];

        if (quote) {
            if (char === quote && previous !== '\\') quote = undefined;
            continue;
        }

        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }

        if (char === '(') depth++;
        if (char === ')') depth--;

        // Depth 0 before the last character means the parens do NOT wrap the whole expression
        if (depth === 0 && i < expression.length - 1) {
            return false;
        }
    }

    return true;
}

/**
 * Escapes special regex metacharacters in `value` so it can be safely embedded
 * inside a `RegExp` constructor pattern.
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
