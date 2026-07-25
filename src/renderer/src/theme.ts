export const theme = {
  bg: '#0a0e13',
  panel: '#12181f',
  surface: '#1a212b',
  surfaceHover: '#212a35',
  border: '#232b36',
  borderLight: '#2e3947',
  text: '#e8edf2',
  textMuted: '#8b98a5',
  textFaint: '#5a6672',
  // Sampled directly from the SSM logo (Security Systems & MORE.png).
  accent: '#00007f',
  accentHover: '#1a1aa8',
  accentPressed: '#00005c',
  // Navy is dark — anything sitting on an accent-colored background needs
  // light text, unlike the old teal which paired with dark text.
  accentText: '#ffffff',
  danger: '#ef4444',
  warning: '#f59e0b',
  success: '#22c55e',
} as const;
