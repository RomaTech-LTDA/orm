/**
 * @module scaffold-service
 *
 * Reverse-engineers an existing database schema into TypeScript entity classes
 * and a DbContext file — the "database-first" approach (similar to EF Core's
 * `Scaffold-DbContext`).
 *
 * The service reads table and column metadata from the provider, then generates:
 * 1. One `.ts` file per table in the output directory, decorated with `@Entity`,
 *    `@PrimaryKey`, and `@Column`.
 * 2. A `DbContext` subclass with a typed `DbSet` for each entity.
 *
 * @example
 * ```ts
 * const service = new ScaffoldService(provider);
 * await service.generateEntitiesFromDb('src/entities', 'src/context', 'AppDbContext');
 * ```
 */

import { IDbProvider } from './provider';
import { DbContext } from './db-context';
import fs from 'fs';
import path from 'path';

/**
 * Names a generated entity class must never take: the identifiers imported by
 * the generated files, and globals used as column types (a class named `Date`
 * would shadow the `Date` type of its own columns).
 */
const RESERVED_CLASS_NAMES = new Set([
    'Entity', 'Column', 'PrimaryKey', 'DbContext', 'DbSet',
    'Array', 'BigInt', 'Boolean', 'Buffer', 'Date', 'Error', 'Function', 'JSON',
    'Map', 'Math', 'Number', 'Object', 'Partial', 'Promise', 'Record', 'RegExp',
    'Set', 'String', 'Symbol'
]);

/** Property names a generated entity class must never declare. */
const RESERVED_PROPERTY_NAMES = new Set(['constructor', '__proto__']);

/**
 * Members of `DbContext` (methods, accessors and instance fields) that a
 * generated `DbSet` getter must never override.
 */
function getReservedContextMembers(): Set<string> {
    return new Set([
        ...Object.getOwnPropertyNames(DbContext.prototype),
        '_dbSets', '_connectionState', '_connectPromise', '_provider',
        '_autoConnect', '_connectionString', '_retryPolicy', '__proto__'
    ]);
}

/**
 * Internal representation of a column during scaffold generation.
 */
type ScaffoldColumn = {
    name: string;
    primaryKey?: boolean;
    tsType?: string;
    type?: string;
};

/**
 * Service that generates entity and context files from an existing database.
 */
export class ScaffoldService {
    /**
     * @param provider - A connected database provider that can introspect schema.
     */
    constructor(private provider: IDbProvider) {}

    /**
     * Reads the database schema and writes entity + context files to disk.
     *
     * @param outputDir - Directory where entity `.ts` files will be written.
     * @param contextDir - Directory where the DbContext file will be written.
     * @param contextName - Name of the generated DbContext class.
     *
     * @example
     * ```ts
     * await service.generateEntitiesFromDb('src/entities', 'src/context', 'AppDbContext');
     * // Generates:
     * //   src/entities/User.ts
     * //   src/entities/Product.ts
     * //   src/context/AppDbContext.ts
     * ```
     */
    async generateEntitiesFromDb(
        outputDir = 'entities',
        contextDir = '.',
        contextName = 'AppDbContext'
    ): Promise<void> {
        if (!isIdentifier(contextName)) {
            throw new Error(`Invalid DbContext class name '${contextName}': use a valid TypeScript identifier.`);
        }

        const tables = await this.provider.getTables();

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const entityClassNames: string[] = [];
        // The context file may share the directory with the entity files
        const usedFileNames = new Set<string>([contextName.toLowerCase()]);

        for (const table of tables) {
            const columns = await this.provider.getColumnsForTable(table);
            // Table names come from the database: the class name is also the
            // file name, so it must be a plain identifier (no path segments),
            // unique ignoring case (Windows and macOS file systems are
            // case-insensitive, so 'Users' and 'USERS' would share a file) and
            // must not shadow an imported or global name.
            const className = uniqueName(
                this.toClassName(table),
                candidate => usedFileNames.has(candidate.toLowerCase()) || RESERVED_CLASS_NAMES.has(candidate)
            );
            usedFileNames.add(className.toLowerCase());
            entityClassNames.push(className);
            const filePath = path.join(outputDir, `${className}.ts`);
            const content = this.generateEntityFileContent(className, table, columns);
            this.writeEntityFile(filePath, content);
        }

        this.generateDbContextFile(contextDir, contextName, entityClassNames, outputDir);
    }

    // ─── Code Generation ─────────────────────────────────────────────────────────

    /**
     * Generates the full TypeScript source for an entity class file.
     *
     * @param className - PascalCase class name.
     * @param table - Original database table name.
     * @param columns - Column metadata for the table.
     * @returns Complete file content string.
     */
    private generateEntityFileContent(
        className: string,
        table: string,
        columns: ScaffoldColumn[]
    ): string {
        const usedProperties = new Set<string>();
        const props = columns.map(col => {
            const isId = col.name === 'id' || col.primaryKey;
            // Distinct columns can map to the same property (`user_name` and
            // `userName`), so property names get a numeric suffix when taken.
            const propertyName = uniqueName(
                this.toPropertyName(col.name),
                candidate => usedProperties.has(candidate) || RESERVED_PROPERTY_NAMES.has(candidate)
            );
            usedProperties.add(propertyName);
            // Only add explicit name option if the property name differs from the column name
            const options = propertyName === col.name ? '' : `{ name: ${toStringLiteral(col.name)} }`;
            const tsType = col.tsType || this.mapDbTypeToTsType(col.type);
            return `  @${isId ? 'PrimaryKey' : 'Column'}(${options})\n  ${propertyName}!: ${tsType};`;
        });

        return `
import { Entity, Column, PrimaryKey } from '@romatech/orm';

@Entity(${toStringLiteral(table)})
export class ${className} {
${props.join('\n\n')}
}
    `.trim();
    }

    /**
     * Writes the generated entity content to a file and logs the path.
     */
    private writeEntityFile(filePath: string, content: string): void {
        fs.writeFileSync(filePath, content);
        console.log(`Entity generated: ${filePath}`);
    }

    /**
     * Generates the DbContext TypeScript file with imports and DbSet getters
     * for all scaffolded entities.
     *
     * @param contextDir - Target directory for the context file.
     * @param contextName - Class name for the generated context.
     * @param entityClassNames - List of entity class names to include.
     * @param entitiesDir - Path to the generated entities (used for relative imports).
     */
    private generateDbContextFile(
        contextDir: string,
        contextName: string,
        entityClassNames: string[],
        entitiesDir: string
    ): void {
        if (!fs.existsSync(contextDir)) {
            fs.mkdirSync(contextDir, { recursive: true });
        }

        const entityImportPath = this.toImportPath(contextDir, entitiesDir);
        const imports = entityClassNames
            .map(name => `import { ${name} } from '${entityImportPath}/${name}';`)
            .join('\n');

        // Getter names must not override DbContext members (a table named
        // 'set' or 'save_changes' would otherwise break the context).
        const reservedMembers = getReservedContextMembers();
        const usedGetters = new Set<string>();
        const getterNames = entityClassNames.map(name => {
            const getter = uniqueName(
                this.toCamelCase(name),
                candidate => usedGetters.has(candidate) || reservedMembers.has(candidate)
            );
            usedGetters.add(getter);
            return getter;
        });

        const dbSets = entityClassNames
            .map((name, index) => [
                `  public get ${getterNames[index]}(): DbSet<${name}> {`,
                `    return this.set(${name});`,
                `  }`
            ].join('\n'))
            .join('\n\n');

        const content = `
import { DbContext, DbSet } from '@romatech/orm';
${imports}

export class ${contextName} extends DbContext {
${dbSets}
}
    `.trim();

        const filePath = path.join(contextDir, `${contextName}.ts`);
        fs.writeFileSync(filePath, content);
        console.log(`DbContext generated: ${filePath}`);
    }

    // ─── String Utilities ────────────────────────────────────────────────────────

    /** Converts `snake_case` or `kebab-case` to `PascalCase`. */
    private toPascalCase(name: string): string {
        return name
            .replace(/[_-](.)/g, (_, c) => c.toUpperCase())
            .replace(/^./, s => s.toUpperCase());
    }

    /** Converts a PascalCase name to camelCase. */
    private toCamelCase(name: string): string {
        return name.charAt(0).toLowerCase() + name.slice(1);
    }

    /** Converts a column name to a valid JS property name (camelCase). */
    private toPropertyName(name: string): string {
        // If already a valid identifier, keep as-is
        if (isIdentifier(name)) {
            return name;
        }
        const converted = this.toCamelCase(this.toPascalCase(name));
        return isIdentifier(converted) ? converted : this.toCamelCase(toIdentifierWords(name));
    }

    /** Converts a table name to a PascalCase class name that is a valid identifier. */
    private toClassName(table: string): string {
        const converted = this.toPascalCase(table);
        return isIdentifier(converted) ? converted : toIdentifierWords(table);
    }

    /**
     * Maps a raw database type string (e.g. 'int', 'varchar') to its TypeScript
     * equivalent.
     */
    private mapDbTypeToTsType(dbType?: string): string {
        const normalized = (dbType || '').toLowerCase();

        if (/(int|decimal|numeric|number|float|double|real|money)/.test(normalized)) {
            return 'number';
        }

        if (/(bool|bit)/.test(normalized)) {
            return 'boolean';
        }

        if (/(date|time)/.test(normalized)) {
            return 'Date';
        }

        if (/(json|array)/.test(normalized)) {
            return 'unknown';
        }

        return 'string';
    }

    /**
     * Calculates the relative import path between two directories.
     * Used for generating import statements in the DbContext file.
     */
    private toImportPath(fromDir: string, toDir: string): string {
        const relativePath = path.relative(path.resolve(fromDir), path.resolve(toDir)).replace(/\\/g, '/');

        if (!relativePath || relativePath === '.') {
            return '.';
        }

        return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
    }
}

/** Appends a numeric suffix (2, 3, …) to `name` while `isTaken` says it is taken. */
function uniqueName(name: string, isTaken: (candidate: string) => boolean): string {
    let candidate = name;
    for (let suffix = 2; isTaken(candidate); suffix++) {
        candidate = `${name}${suffix}`;
    }
    return candidate;
}

/** Returns `true` when `value` is a plain JavaScript identifier. */
function isIdentifier(value: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

/**
 * Builds a PascalCase identifier from the alphanumeric words of `value`
 * (e.g. `'../../my table'` → `'MyTable'`, `'2024 sales'` → `'_2024Sales'`).
 */
function toIdentifierWords(value: string): string {
    const words = value.split(/[^A-Za-z0-9$]+/).filter(Boolean);
    const name = words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('') || 'Entity';
    return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** Renders `value` as a single-quoted TypeScript string literal. */
function toStringLiteral(value: string): string {
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return `'${escaped}'`;
}

