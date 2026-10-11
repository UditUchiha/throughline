import type { LucideIcon } from 'lucide-react';

/**
 * The tint is mixed against `--surface` explicitly rather than layered over
 * whatever is behind it. Accent-on-tint contrast was measured against that exact
 * mix, in both themes; a translucent tint over the canvas would land somewhere
 * else and quietly fall under 4.5:1 in the light theme.
 */
const TONES = {
  warn: {
    box: 'border-warn/40 bg-[color-mix(in_oklab,var(--warn)_10%,var(--surface))]',
    accent: 'text-warn',
  },
  danger: {
    box: 'border-danger/40 bg-[color-mix(in_oklab,var(--danger)_10%,var(--surface))]',
    accent: 'text-danger',
  },
} as const;

export function Callout({
  tone,
  icon: Icon,
  title,
  spin = false,
  urgent = false,
  children,
}: {
  tone: keyof typeof TONES;
  icon: LucideIcon;
  title: string;
  spin?: boolean;
  /** `alert` interrupts a screen reader; reserve it for something that went wrong. */
  urgent?: boolean;
  children: React.ReactNode;
}) {
  const style = TONES[tone];

  return (
    <div
      role={urgent ? 'alert' : 'status'}
      className={`animate-enter flex gap-3 rounded-xl border px-4 py-3 ${style.box}`}
    >
      <Icon
        className={`mt-0.5 size-5 shrink-0 ${style.accent} ${spin ? 'animate-spin' : ''}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        <p className={`font-semibold ${style.accent}`}>{title}</p>
        <div className="mt-1 space-y-2 text-fg-2">{children}</div>
      </div>
    </div>
  );
}
