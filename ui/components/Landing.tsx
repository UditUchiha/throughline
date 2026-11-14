/** The argument, before the visitor has asked anything. Shown only while idle. */
export function Intro() {
  return (
    <section className="animate-enter pt-10 sm:pt-16">
      <h1 className="max-w-3xl text-4xl leading-[1.08] font-semibold tracking-tight text-balance text-fg sm:text-5xl lg:text-6xl">
        Some answers are not in any one document.
      </h1>

      <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
        The cause is in a chat thread, the sign-off is in an email. Ask once: this searches
        mail, chat and notes together, goes back for what it missed, and shows the exact
        passage behind every claim.
      </p>
    </section>
  );
}
