import fs from 'node:fs/promises';

import pkg from '@storybook/addon-svelte-csf/package.json' with { type: 'json' };
import type { IndexInput } from '@storybook/types';
import type { Identifier, Property } from 'estree';
import { preprocess, type Script, type SvelteNode } from 'svelte/compiler';

import { getSvelteAST } from '#parser/ast';
import { extractStoryAttributesNodes } from '#parser/extract/svelte/story/attributes';
import { getStoryIdentifiers } from '#parser/analyse/story/attributes/identifiers';
import {
  getArrayOfStringsValueFromAttribute,
  getStringValueFromAttribute,
} from '#parser/analyse/story/attributes';
import {
  getPropertyArrayOfStringsValue,
  getPropertyStringValue,
} from '#parser/analyse/define-meta/properties';
import type { StorybookAddonSvelteCsFOptions } from '#preset';
import {
  DefaultOrNamespaceImportUsedError,
  GetDefineMetaFirstArgumentError,
  MissingModuleTagError,
} from '#utils/error/parser/extract/svelte';

interface Results {
  meta: Pick<IndexInput, 'title' | 'tags'>;
  stories: Array<Pick<IndexInput, 'exportName' | 'name' | 'tags'>>;
}

export async function parseForIndexer(
  filename: string,
  options: Partial<StorybookAddonSvelteCsFOptions>
): Promise<Results> {
  let [code, { walk }, { loadSvelteConfig }] = await Promise.all([
    fs.readFile(filename, { encoding: 'utf8' }),
    import('zimmerframe'),
    import('@sveltejs/vite-plugin-svelte'),
  ]);

  const { legacyTemplate } = options;
  const svelteConfig = await loadSvelteConfig();

  let defineMetaIdentifier = 'defineMeta';
  let componentStoryIdentifier = 'Story';
  // TODO: Remove it in the next major version
  let componentMetaIdentifier = 'Meta';

  if (svelteConfig?.preprocess) {
    code = (
      await preprocess(code, svelteConfig.preprocess, {
        filename: filename,
      })
    ).code;
  }

  const svelteAST = getSvelteAST({ code, filename });
  let results: Results = {
    meta: {},
    stories: [],
  };

  let foundMeta = false;

  walk(svelteAST as SvelteNode | Script, results, {
    _(_node, context) {
      const { next, state } = context;
      next(state);
    },

    Root(node, context) {
      const { module, fragment } = node;
      const { state, visit } = context;

      if (!module && !legacyTemplate) {
        throw new MissingModuleTagError(filename);
      }

      visit(fragment, state);
    },

    Script(node, context) {
      const { content, context: scriptContext } = node;
      const { state, visit } = context;
      if (scriptContext === 'module') {
        visit(content, state);
      }
    },

    Program(node, context) {
      const { body } = node;
      const { state, visit } = context;

      for (const statement of body) {
        if (
          legacyTemplate &&
          statement.type === 'ImportDeclaration' &&
          statement.source.value === pkg.name
        ) {
          visit(statement, state);
        }

        if (statement.type === 'VariableDeclaration') {
          visit(statement, state);
        }

        // TODO: Remove it in the next major version
        if (legacyTemplate && statement.type === 'ExportNamedDeclaration') {
          const { declaration } = statement;

          if (declaration?.type === 'VariableDeclaration') {
            visit(declaration, state);
          }
        }
      }
    },

    ImportDeclaration(node, _context) {
      const { specifiers } = node;

      for (const specifier of specifiers) {
        if (specifier.type !== 'ImportSpecifier') {
          throw new DefaultOrNamespaceImportUsedError(filename);
        }

        if (legacyTemplate && specifier.import.name === defineMetaIdentifier) {
          componentMetaIdentifier = specifier.local.name;
        }

        // TODO: Remove it in the next major version
        if (legacyTemplate && specifier.import.name === componentMetaIdentifier) {
          componentMetaIdentifier = specifier.local.name;
        }

        // TODO: Remove it in the next major version
        if (legacyTemplate && specifier.import.name === componentStoryIdentifier) {
          componentStoryIdentifier = specifier.local.name;
        }
      }
    },

    VariableDeclaration(node, context) {
      const { declarations } = node;
      const { state, visit } = context;
      const { id, init } = declarations[0];

      if (init?.type === 'CallExpression') {
        const { arguments: arguments_, callee } = init;

        if (callee.type === 'Identifier' && callee.name === defineMetaIdentifier) {
          foundMeta = true;

          if (id?.type !== 'ObjectPattern') {
            // TODO:
            throw new Error('Invalid syntax');
          }

          const { properties } = id;
          const destructuredStoryIdentifier = properties.find(
            (property) =>
              property.type === 'Property' &&
              property.key.type === 'Identifier' &&
              property.key.name === componentStoryIdentifier
          ) as Property | undefined;

          if (!destructuredStoryIdentifier) {
            // TODO:
            throw new Error('Invalid syntax');
          }

          componentStoryIdentifier = (destructuredStoryIdentifier.value as Identifier).name;

          if (arguments_[0].type !== 'ObjectExpression') {
            throw new GetDefineMetaFirstArgumentError({
              filename,
              defineMetaVariableDeclaration: node,
            });
          }

          visit(arguments_[0], state);
        }
      }

      if (legacyTemplate && !foundMeta && id.type === 'Identifier') {
        const { name } = id;

        if (name === 'meta') {
          foundMeta = true;

          if (init?.type !== 'ObjectExpression') {
            throw new GetDefineMetaFirstArgumentError({
              filename,
              defineMetaVariableDeclaration: node,
            });
          }

          visit(init, state);
        }
      }
    },

    // NOTE: We assume this one is value of first argument passed to `defineMeta({ ... })` call,
    // or assigned value to legacy `export const meta = {}`
    ObjectExpression(node, context) {
      const { properties } = node;
      const { state, visit } = context;

      for (const property of properties) {
        if (property.type === 'Property' && property.key.type === 'Identifier') {
          visit(node, state);
        }
      }
    },

    // NOTE: We assume these properties are from 'meta' _(from `defineMeta` or `export const meta`)_ object expression
    Property(node: Property, context) {
      const { key } = node as Property;
      const { state } = context;
      const { name } = key as Identifier;

      if (name === 'title') {
        state.meta.title = getPropertyStringValue({ node, filename });
      }

      if (name === 'tags') {
        state.meta.tags = getPropertyArrayOfStringsValue({
          node,
          filename,
        });
      }
    },

    Fragment(node, context) {
      const { nodes } = node;
      const { state, visit } = context;

      for (const node of nodes) {
        if (node.type === 'Component') {
          visit(node, state);
        }
      }
    },

    Component(node, context) {
      const { name } = node;
      const { state } = context;

      // TODO: Remove in the next major version
      if (!foundMeta && legacyTemplate && name === componentMetaIdentifier) {
        const { attributes } = node;
        for (const attribute of attributes) {
          if (attribute.type === 'Attribute') {
            const { name } = attribute;

            if (name === 'title') {
              state.meta.title ===
                getStringValueFromAttribute({
                  component: node,
                  node: attribute,
                  filename,
                });
            }

            if (name === 'tags') {
              state.meta.tags ===
                getArrayOfStringsValueFromAttribute({
                  component: node,
                  node: attribute,
                  filename,
                });
            }
          }
        }
      }

      if (name === componentStoryIdentifier) {
        const attribute = extractStoryAttributesNodes({
          component: node,
          attributes: ['exportName', 'name', 'tags'],
        });

        const { exportName, name } = getStoryIdentifiers({
          component: node,
          nameNode: attribute.name,
          exportNameNode: attribute.exportName,
          filename,
        });
        const tags = getArrayOfStringsValueFromAttribute({
          component: node,
          node: attribute.tags,
          filename,
        });

        state.stories.push({
          exportName,
          name,
          tags,
        });
      }
    },
  });

  return results;
}
