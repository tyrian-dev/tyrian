import Link from "next/link";
import Image from "next/image";

export default function NotFound() {
  return (
    <div className="page-error-shell">
      <header className="err-header">
        <Link className="wordmark" href="/" aria-label="Tyrian home">
          <Image
            src="/logo.png"
            alt="Tyrian logo"
            width={32}
            height={32}
            className="mark"
          />
          TYRIAN
        </Link>
      </header>

      <main
        className="page-error"
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          padding: "40px 16px 80px",
          textAlign: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <svg
          className="orn"
          viewBox="-100 -100 200 200"
          aria-hidden="true"
          style={{
            position: "absolute",
            width: "min(900px, 140vw)",
            opacity: 0.14,
            color: "var(--tyr-400)",
            animation: "turn 80s linear infinite",
          }}
        >
          <use href="#murex" />
        </svg>
        <div style={{ position: "relative", zIndex: 1 }}>
          <div
            className="err-code"
            style={{
              font: "500 13px 'JetBrains Mono', monospace",
              letterSpacing: ".18em",
              color: "var(--gold-500)",
            }}
          >
            ERROR 404
          </div>
          <h1
            style={{
              font: "600 clamp(40px, 8vw, 84px)/1.05 Cinzel, serif",
              letterSpacing: ".04em",
              margin: "18px 0",
            }}
          >
            This scroll was
            <br />
            <span>never written.</span>
          </h1>
          <p
            style={{
              color: "var(--text-muted)",
              maxWidth: "42ch",
              margin: "0 auto 32px",
              fontSize: "16px",
            }}
          >
            The page you asked for doesn&apos;t exist or has moved. The way home is still open.
          </p>
          <Link className="btn btn-primary btn-lg" href="/" style={{ height: "52px", padding: "0 26px" }}>
            Back to Tyrian
          </Link>
        </div>
      </main>
    </div>
  );
}
