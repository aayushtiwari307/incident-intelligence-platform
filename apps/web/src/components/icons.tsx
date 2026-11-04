import type { ReactNode } from "react";

/** Line icons from the Control Room design. Decorative by default (aria-hidden); the surrounding control carries the label. */
const PATHS: Record<string, ReactNode> = {
  pulse: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  incidents: (
    <>
      <path d="M12 3l9 16H3L12 3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  services: (
    <>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  github: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 7v10M18 11c0 4-6 3-12 6" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M17 11a3 3 0 100-6M21 20c0-2.5-1.5-4.6-4-5.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12l5 5 9-10" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4z" />,
  link: (
    <>
      <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
    </>
  ),
  signout: (
    <>
      <path d="M9 4H5a1 1 0 00-1 1v14a1 1 0 001 1h4" />
      <path d="M16 8l4 4-4 4M20 12H9" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  inbox: (
    <>
      <path d="M4 13l2-8h12l2 8" />
      <path d="M4 13v6h16v-6h-5l-1 2h-4l-1-2H4z" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, stroke = 1.9 }: { name: IconName; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** The amber pulse-line logo mark. */
export function LogoMark({ large = false }: { large?: boolean }) {
  return (
    <span className={`logo-mark${large ? " large" : ""}`}>
      <svg width={large ? 18 : 16} height={large ? 18 : 16} viewBox="0 0 24 24" fill="none" stroke="#0B0B0C" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M2 12h5l3-8 4 16 3-8h5" />
      </svg>
    </span>
  );
}
