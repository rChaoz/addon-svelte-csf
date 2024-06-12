import { getContext, hasContext, setContext, type ComponentProps } from 'svelte';

import type Story from '#runtime/Story.svelte';

import type { Meta } from '#types';

const CONTEXT_KEYS = 'storybook-stories-template-snippet-context';

function buildContext<TMeta extends Meta = Meta>() {
  let template = $state<ComponentProps<Story<TMeta>>['children']>();

  function set(snippet?: typeof template) {
    template = snippet;
  }

  return {
    get template() {
      return template;
    },
    set,
  };
}

type StoriesTemplateContext<TMeta extends Meta = Meta> = ReturnType<typeof buildContext<TMeta>>;

export function useStoriesTemplate<TMeta extends Meta = Meta>() {
  if (!hasContext(CONTEXT_KEYS)) {
    setContext(CONTEXT_KEYS, buildContext<TMeta>());
  }

  return getContext<StoriesTemplateContext<TMeta>>(CONTEXT_KEYS).template;
}

type InferMeta<TStory extends Story<Meta>> =
  TStory extends Story<infer TMeta extends Meta> ? TMeta : never;

export function setTemplate<TStory extends Story<Meta>>(
  snippet?: StoriesTemplateContext<InferMeta<TStory>>['template']
): void {
  if (!hasContext(CONTEXT_KEYS)) {
    setContext(CONTEXT_KEYS, buildContext<InferMeta<TStory>>());
  }

  const ctx = getContext<StoriesTemplateContext<InferMeta<TStory>>>(CONTEXT_KEYS);

  ctx.set(snippet);
}
