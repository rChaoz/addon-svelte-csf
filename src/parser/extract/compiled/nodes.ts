import pkg from '@storybook/addon-svelte-csf/package.json' with { type: 'json' };
import type {
  Comment,
  ExportDefaultDeclaration,
  FunctionDeclaration,
  Identifier,
  ImportSpecifier,
  Node,
  Program,
  VariableDeclaration,
} from 'estree';
import type { Visitors } from 'zimmerframe';

export interface CompiledASTNodes {
  /**
   * Import specifier for `defineMeta` imported from this addon package.
   * Could be renamed - e.g. `import { defineMeta } from "@storybook/addon-svelte-csf"`
   */
  defineMetaImport: ImportSpecifier;
  /**
   * Variable declaration: `const { Story } = defineMeta({ })`
   * Could be destructured with rename - e.g. `const { Story: S } = defineMeta({ ... })`
   */
  defineMetaVariableDeclaration: VariableDeclaration;
  /**
   * Store the `export default declaration`, we will need to remove it later.
   * Why? Storybook expects `export default meta`, instead of what `@sveltejs/vite-plugin-svelte` will produce.
   */
  exportDefault: ExportDefaultDeclaration;
  /**
   * An identifier for the addon's component `<Story />`.
   * It could be destructured with rename - e.g. `const { Story: S } = defineMeta({ ... })`
   */
  storyIdentifier: Identifier;
  /**
   * A function declaration for the main Svelte component which is the `*.stories.svelte` file.
   */
  storiesFunctionDeclaration: FunctionDeclaration;
}

const AST_NODES_NAMES = {
  defineMeta: 'defineMeta',
  Story: 'Story',
} as const;

interface Params {
  ast: Program;
  filename?: string;
}

/**
 * Extract compiled AST nodes from Vite _(via `rollup`)_.
 * Those nodes are required for further code transformation.
 */
export async function extractCompiledASTNodes(params: Params): Promise<CompiledASTNodes> {
  const { walk } = await import('zimmerframe');

  const { ast, filename } = params;
  const state: Partial<CompiledASTNodes> = {};
  const visitors: Visitors<Node | Comment, typeof state> = {
    ImportDeclaration(node, { state, visit }) {
      const { source, specifiers } = node;

      if (source.value === pkg.name) {
        for (const specifier of specifiers) {
          if (specifier.type !== 'ImportSpecifier') {
            throw new Error(
              `Don't use the default/namespace import from "${pkg.name}" in the stories file: ${filename}`
            );
          }

          visit(specifier, state);
        }
      }
    },

    ImportSpecifier(node, {}) {
      if (node.imported.name === AST_NODES_NAMES.defineMeta) {
        state.defineMetaImport = node;
      }
    },

    VariableDeclaration(node, { state }) {
      const { declarations } = node;
      const declaration = declarations[0];
      const { id, init } = declaration;

      if (
        id.type === 'ObjectPattern' &&
        init?.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        init.callee.name === state.defineMetaImport?.local.name
      ) {
        state.defineMetaVariableDeclaration = node;

        for (const property of id.properties) {
          if (
            property.type === 'Property' &&
            property.key.type === 'Identifier' &&
            property.key.name === AST_NODES_NAMES.Story &&
            property.value.type === 'Identifier'
          ) {
            state.storyIdentifier = property.value;
          }
        }
      }
    },

    ExportDefaultDeclaration(node, { state }) {
      state.exportDefault = node;

      // WARN: This may be confusing.
      // In the `NODE_ENV="production"` the export default is different.
      // Identifier to a FunctionDeclaration.
      if (
        process.env.NODE_ENV === 'production' &&
        node.declaration.type === 'FunctionDeclaration' &&
        isStoriesComponentFn(node.declaration as FunctionDeclaration)
      ) {
        state.storiesFunctionDeclaration = node.declaration as FunctionDeclaration;
      }
    },

    FunctionDeclaration(node, { state }) {
      // WARN: This may be confusing.
      // In the `NODE_ENV="development"` the export default is different.
      // A `FunctionDeclaration`
      if (isStoriesComponentFn(node)) {
        state.storiesFunctionDeclaration = node;
      }
    },
  };

  walk(ast, state, visitors);

  const {
    defineMetaImport,
    defineMetaVariableDeclaration,
    exportDefault,
    storyIdentifier,
    storiesFunctionDeclaration,
  } = state;

  if (!defineMetaImport) {
    throw new Error(
      `Could not find '${AST_NODES_NAMES.defineMeta}' imported from the "${pkg.name}" in the compiled output of stories file: ${filename}`
    );
  }

  if (!defineMetaVariableDeclaration) {
    throw new Error(
      `Could not find '${defineMetaImport.local.name}({ ... })' in the compiled output of the stories file: ${filename}`
    );
  }

  if (!exportDefault) {
    throw new Error(
      `Could not find 'export default' in the compiled output of the stories file: ${filename}`
    );
  }

  if (!storyIdentifier) {
    throw new Error(
      `Could not find 'Story' identifier in the compiled output of the stories file: ${filename}`
    );
  }

  if (!storiesFunctionDeclaration) {
    throw new Error(
      `Could not find the stories component '*.stories.svelte' function in the compiled output of the stories file: ${filename}`
    );
  }

  return {
    defineMetaImport,
    defineMetaVariableDeclaration,
    exportDefault,
    storyIdentifier,
    storiesFunctionDeclaration,
  };
}

/**
 *:The main component function of those stories file _(`*.stories.svelte`)_ will always end up with `_stories`.
 * @see {@link "file://./../../../utils/get-component-name.ts"}
 */
const isStoriesComponentFn = (fnDeclaration: FunctionDeclaration) =>
  fnDeclaration.id?.name.endsWith('_stories');
