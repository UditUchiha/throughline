import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';
import { THEME_STORAGE_KEY } from '@/lib/theme';
import './globals.css';

// Self-hosted at build time by next/font, so there is no request to Google from
// the visitor's browser and no layout shift when the face arrives.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'throughline — agentic RAG over scattered work data',
  description:
    'Ask a question whose answer lives in no single document. Watch the agent plan, ' +
    'fan out across mail, chat and notes, notice its own gaps, and answer with citations ' +
    'that resolve to the exact passage they came from.',
};

export const viewport: Viewport = {
  themeColor: '#0d1117',
  // Recruiters open portfolio links on phones (PLAN.md §5/M2), so the whole thing
  // has to work at 375px without a pinch-zoom escape hatch covering for the layout.
  width: 'device-width',
  initialScale: 1,
};

/**
 * Applies a stored theme before first paint.
 *
 * It has to be an inline script in the document rather than an effect: an effect
 * runs after the browser has already painted the dark default, so a visitor who
 * chose light would see a dark flash on every load. Guarded because storage
 * access throws outright when site data is blocked.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The script above edits this element's attributes before React hydrates,
    // which is exactly the mismatch this flag exists to permit.
    <html lang="en" className={`${plexSans.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
