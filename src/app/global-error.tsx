"use client";

/** Last-resort boundary — renders its own minimal shell if the root layout itself fails */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ background: "#fbfbf8", fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "24px",
            color: "#101812",
          }}
        >
          <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>SecureVoice AI</h1>
          <p style={{ fontSize: 14, color: "#4b5a50", maxWidth: 420, lineHeight: 1.6 }}>
            The platform failed to start. This is unusual — a reload almost always fixes it.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 24,
              background: "#0b7a55",
              color: "#fff",
              border: "none",
              borderRadius: 999,
              padding: "12px 28px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload SecureVoice AI
          </button>
          {error.digest && (
            <p style={{ marginTop: 20, fontSize: 11, color: "#8a968d" }}>REF: {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  );
}
