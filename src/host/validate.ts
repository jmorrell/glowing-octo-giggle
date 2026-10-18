import type { ContentRef, DetailView, PluginManifest, ProcessResult, ProcessorName, Selector } from "../contract";

export const ARTIFACT_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const MAX_SEGMENTS = 5000;

// Media types the host will serve from its own origin. Active content (HTML, SVG, script)
// would execute with the application's authority, so plugins cannot store it.
const SERVABLE = /^(image\/(png|jpeg|webp|gif|bmp)|video\/(webm|mp4)|audio\/(webm|mpeg|ogg)|application\/(json|octet-stream|vnd\.apache\.parquet)|text\/plain)$/;

export function isServableMediaType(mediaType: string): boolean {
  return SERVABLE.test(mediaType);
}

interface Context {
  manifest: PluginManifest;
  processor: ProcessorName;
  stagedNames: ReadonlySet<string>;
  componentNames: ReadonlySet<string>;
}

/** Returns every problem with a processor's result; the host commits only an empty list. */
export function validateResult(result: ProcessResult, context: Context): string[] {
  let problems: string[] = [];
  let text = (value: unknown, max: number, path: string) => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) problems.push(`${path}: expected 1-${max} characters`);
  };
  let ref = (value: ContentRef | undefined, path: string) => {
    if (value === undefined || value === "original") return;
    if (!context.manifest.processors.includes(value.processor)) problems.push(`${path}: unknown processor ${value.processor}`);
    else if (!ARTIFACT_NAME.test(value.name)) problems.push(`${path}: invalid artifact name`);
    // Other processors' artifacts are bound late; this run's own must already be staged.
    else if (value.processor === context.processor && !context.stagedNames.has(value.name)) {
      problems.push(`${path}: ${value.name} was not stored by this run`);
    }
  };
  let selector = (value: Selector, path: string) => {
    if (value.type === "time") {
      if (!(Number.isFinite(value.start) && Number.isFinite(value.end) && value.start >= 0 && value.end >= value.start)) problems.push(`${path}: invalid time range`);
    } else if (value.type === "text-quote") {
      ref(value.in, `${path}.in`);
      text(value.exact, 1000, `${path}.exact`);
    } else if (value.type === "plugin") {
      if (value.plugin !== context.manifest.id) problems.push(`${path}: plugin selectors must name their own plugin`);
      text(value.value, 500, `${path}.value`);
      text(value.label, 200, `${path}.label`);
    } else {
      problems.push(`${path}: unknown selector`);
    }
  };
  let detail = (value: DetailView, path: string, allowCustom: boolean) => {
    if (value.template === "media") {
      ref(value.media, `${path}.media`);
      ref(value.cues, `${path}.cues`);
      ref(value.thumbnails, `${path}.thumbnails`);
    } else if (value.template === "record") {
      if (value.fields.length > 200) problems.push(`${path}.fields: too many`);
      value.fields.forEach((field, index) => {
        text(field.label, 100, `${path}.fields[${index}].label`);
        text(field.value, 2000, `${path}.fields[${index}].value`);
      });
      for (let [index, list] of (value.lists ?? []).entries()) {
        text(list.label, 100, `${path}.lists[${index}].label`);
        if (list.items.length > 500) problems.push(`${path}.lists[${index}]: too many items`);
        list.items.forEach((item, itemIndex) => text(item, 500, `${path}.lists[${index}].items[${itemIndex}]`));
      }
    } else if (value.template === "custom" && allowCustom) {
      if (!context.componentNames.has(value.component)) problems.push(`${path}.component: not in this release`);
      ref(value.data, `${path}.data`);
      detail(value.fallback, `${path}.fallback`, false);
    } else {
      problems.push(`${path}: unknown template`);
    }
  };

  if (result.views) {
    if (context.processor !== context.manifest.views) problems.push("views: only the views processor may return views");
    text(result.views.card.title, 300, "views.card.title");
    if (result.views.card.subtitle !== undefined) text(result.views.card.subtitle, 300, "views.card.subtitle");
    ref(result.views.card.image, "views.card.image");
    if ((result.views.card.badges?.length ?? 0) > 8) problems.push("views.card.badges: too many");
    result.views.card.badges?.forEach((badge, index) => text(badge, 40, `views.card.badges[${index}]`));
    detail(result.views.detail, "views.detail", true);
  } else if (context.processor === context.manifest.views) {
    problems.push("views: the views processor must return views");
  }
  if (result.metadata?.title !== undefined) text(result.metadata.title, 300, "metadata.title");
  if (result.metadata?.description !== undefined) text(result.metadata.description, 2000, "metadata.description");
  let segments = result.search ?? [];
  if (segments.length > MAX_SEGMENTS) problems.push(`search: more than ${MAX_SEGMENTS} segments`);
  segments.forEach((segment, index) => {
    text(segment.text, 4000, `search[${index}].text`);
    if (segment.target) selector(segment.target, `search[${index}].target`);
  });
  return problems;
}
