import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'throughline — agentic RAG over scattered work data',
  description:
    'Ask a question whose answer lives in no single document. Watch the agent plan, ' +
    'fan out across mail, chat and notes, notice its own gaps, and answer with citations ' +
    'that resolve to the exact passage they came from.',
};

export const viewport: Viewport = {
  themeColor: '#0b0f14',
  // Recruiters open portfolio links on phones (PLAN.md §5/M2), so the whole thing
  // has to work at 375px without a pinch-zoom escape hatch covering for the layout.
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
