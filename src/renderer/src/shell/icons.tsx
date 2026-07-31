// Plain vector (stroke/fill=currentColor) icons for the header buttons that
// previously used emoji characters (☀ 🌙 📖 ❓ ℹ). Windows renders those
// specific codepoints via its color-emoji font (Segoe UI Emoji) rather than
// the plain text glyph — a small multi-layer bitmap font that looks fine
// against a dark background but shows visible blur/aliasing against a
// light one (the other header icons, like the gear and window controls,
// never had this problem since they're plain monochrome Unicode symbols,
// not emoji-presentation characters). SVG with currentColor sidesteps the
// whole issue: same crisp vector rendering in both themes, and it
// automatically follows the button's hover color for free.

function IconSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function SunIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4.5" />
      <line x1="12" y1="19.5" x2="12" y2="22" />
      <line x1="2" y1="12" x2="4.5" y2="12" />
      <line x1="19.5" y1="12" x2="22" y2="12" />
      <line x1="4.9" y1="4.9" x2="6.6" y2="6.6" />
      <line x1="17.4" y1="17.4" x2="19.1" y2="19.1" />
      <line x1="4.9" y1="19.1" x2="6.6" y2="17.4" />
      <line x1="17.4" y1="6.6" x2="19.1" y2="4.9" />
    </IconSvg>
  );
}

export function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.5 14.7A8.5 8.5 0 1 1 9.3 3.5a7 7 0 0 0 11.2 11.2z" />
    </svg>
  );
}

export function InfoIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <line x1="12" y1="7.5" x2="12" y2="7.5" />
    </IconSvg>
  );
}
