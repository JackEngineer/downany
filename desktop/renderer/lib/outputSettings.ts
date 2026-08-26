export type SubtitleMode = "none" | "external" | "embedded" | "both";

export function subtitleModeFromSettings(settings: {
  download_subtitles?: boolean;
  embed_subs?: boolean;
}): SubtitleMode {
  const external = Boolean(settings.download_subtitles);
  const embedded = Boolean(settings.embed_subs);
  if (external && embedded) return "both";
  if (external) return "external";
  if (embedded) return "embedded";
  return "none";
}

export function subtitleModePatch(mode: SubtitleMode): {
  download_subtitles: boolean;
  embed_subs: boolean;
} {
  switch (mode) {
    case "none":
      return { download_subtitles: false, embed_subs: false };
    case "external":
      return { download_subtitles: true, embed_subs: false };
    case "embedded":
      return { download_subtitles: false, embed_subs: true };
    case "both":
      return { download_subtitles: true, embed_subs: true };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
