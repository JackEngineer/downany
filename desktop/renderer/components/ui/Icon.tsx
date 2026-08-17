import type { JSX } from "react";

export type IconName =
  | "link"
  | "plus"
  | "capture"
  | "search"
  | "more"
  | "settings"
  | "open"
  | "pause"
  | "play"
  | "retry"
  | "folder"
  | "close"
  | "download"
  | "check"
  | "chevron-down"
  | "chevron-right";

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

function glyph(name: IconName): JSX.Element {
  switch (name) {
    case "link":
      return (
        <>
          <path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.14-1.14" />
        </>
      );
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "capture":
      return (
        <>
          <path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
          <path d="M8 12h8" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="6" />
          <path d="m16 16 4 4" />
        </>
      );
    case "more":
      return (
        <>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      );
    case "settings":
      return (
        <>
          <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
          <circle cx="16" cy="6" r="2" />
          <circle cx="8" cy="12" r="2" />
          <circle cx="14" cy="18" r="2" />
        </>
      );
    case "open":
      return (
        <>
          <path d="M14 5h5v5M19 5l-8 8" />
          <path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </>
      );
    case "pause":
      return <path d="M9 5v14M15 5v14" />;
    case "play":
      return <path d="m9 5 10 7-10 7Z" />;
    case "retry":
      return (
        <>
          <path d="M20 7v5h-5" />
          <path d="M19 12a7 7 0 1 0-2 5" />
        </>
      );
    case "folder":
      return <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />;
    case "close":
      return <path d="m6 6 12 12M18 6 6 18" />;
    case "download":
      return (
        <>
          <path d="M12 4v11M8 11l4 4 4-4" />
          <path d="M5 20h14" />
        </>
      );
    case "check":
      return <path d="m5 12 4 4L19 6" />;
    case "chevron-down":
      return <path d="m7 9 5 5 5-5" />;
    case "chevron-right":
      return <path d="m9 7 5 5-5 5" />;
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}

export function Icon({ name, size = 16, className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ui-icon ${className}`.trim()}
      width={size}
      height={size}
      data-icon={name}
      aria-hidden="true"
      focusable="false"
    >
      {glyph(name)}
    </svg>
  );
}
