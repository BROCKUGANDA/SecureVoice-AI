import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="micro text-primary">404 · Not found</p>
      <h1 className="font-display mt-4 text-3xl font-semibold tracking-tight">
        This page doesn&apos;t exist
      </h1>
      <p className="mt-3 max-w-md text-[14px] leading-relaxed text-ink-2">
        SecureVoice AI lives on a single console. Head back to the overview to explore the platform,
        or jump straight into the live simulation.
      </p>
      <Link
        href="/"
        className="mt-7 rounded-full bg-primary px-6 py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep"
      >
        Back to overview
      </Link>
    </div>
  );
}
