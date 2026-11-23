const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  terminal: <path d="m5 17 5-5-5-5M12 19h7" />,
  alert: (
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 3.5v5h-5" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  shield: <path d="M12 21s7-3.5 7-9.5V5.5L12 3 5 5.5v6c0 6 7 9.5 7 9.5ZM12 8v4M12 15.5h.01" />,
  check: <path d="M20 6 9 17l-5-5" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  plug: <path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v3" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  external: (
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  book: <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4ZM5 17a3 3 0 0 1 3-3h11" />,
  unlink: (
    <path d="M9 15 15 9M10 6l1-1a4.2 4.2 0 0 1 6 6l-1 1M14 18l-1 1a4.2 4.2 0 0 1-6-6l1-1M3 3l18 18" />
  ),
} as const;

export type IconName = keyof typeof PATHS;

/** Decorative stroke icon; label the surrounding control instead. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
