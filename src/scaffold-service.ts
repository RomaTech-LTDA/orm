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
import fs from 'fs';
import path from 'path';

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
        const tables = await this.provider.getTables();

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const entityClassNames: string[] = [];

        for (const table of tables) {
            const columns = await this.provider.getColumnsForTable(table);
            const className = this.toPascalCase(table);
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
        const props = columns.map(col => {
            const isId = col.name === 'id' || col.primaryKey;
            const propertyName = this.toPropertyName(col.name);
            // Only add explicit name option if the property name differs from the column name
            const options = propertyName === col.name ? '' : `{ name: '${col.name}' }`;
            const tsType = col.tsType || this.mapDbTypeToTsType(col.type);
            return `  @${isId ? 'PrimaryKey' : 'Column'}(${options})\n  ${propertyName}!: ${tsType};`;
        });

        return `
import { Entity, Column, PrimaryKey } from '@romatech/orm';

@Entity('${table}')
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

        const dbSets = entityClassNames
            .map(name => [
                `  public get ${this.toCamelCase(name)}(): DbSet<${name}> {`,
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
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
            return name;
        }
        return this.toCamelCase(this.toPascalCase(name));
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
