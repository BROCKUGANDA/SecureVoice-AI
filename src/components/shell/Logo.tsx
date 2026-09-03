"use client";

import { useId } from "react";

/**
 * SecureVoice brand mark — a shield whose interior is a live voice waveform.
 * Voice inside protection: the product in one glyph.
 */
export function LogoMark({
  size = 36,
  className,
  tile = true,
}: {
  size?: number;
  className?: string;
  tile?: boolean;
}) {
  const uid = useId().replace(/[:]/g, "");
  const grad = `svg-grad-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      role="img"
      aria-label="SecureVoice AI"
    >
      <defs>
        <linearGradient id={grad} x1="10" y1="8" x2="38" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2ed3a0" />
          <stop offset="0.55" stopColor="#17a673" />
          <stop offset="1" stopColor="#0b7a55" />
        </linearGradient>
      </defs>

      {tile && (
        <>
          <rect width="48" height="48" rx="13" fill="#0c110e" />
          <rect x="0.5" y="0.5" width="47" height="47" rx="12.5" stroke="white" strokeOpacity="0.06" />
        </>
      )}

      {/* shield outline */}
      <path
        d="M24 8.6 L35.6 12.9 V22.3 C35.6 29.8 30.7 35.5 24 39.4 C17.3 35.5 12.4 29.8 12.4 22.3 V12.9 Z"
        stroke={`url(#${grad})`}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />

      {/* voice waveform inside the shield */}
      <g fill={`url(#${grad})`}>
        <rect x="16.9" y="21.2" width="2.7" height="5.6" rx="1.35" opacity="0.85" />
        <rect x="21.35" y="17.2" width="2.7" height="13.6" rx="1.35" />
        <rect x="25.8" y="19.2" width="2.7" height="9.6" rx="1.35" opacity="0.85" />
        <rect x="30.25" y="22.4" width="2.7" height="3.2" rx="1.35" opacity="0.6" />
      </g>
    </svg>
  );
}
