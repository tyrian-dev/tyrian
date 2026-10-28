import Link from "next/link";
import { CaBadge } from "@/components/ui/CaBadge";

export function Footer() {
  return (
    <footer>
      <div className="wrap foot-grid">
        <div>
          <Link href="/" className="wordmark" aria-label="Tyrian home">
            <svg className="mark" role="img" aria-label="Tyrian logo">
              <use href="#mark" />
            </svg>
            TYRIAN
          </Link>
          <p style={{ marginTop: "12px" }}>
            Stake assets, use every AI model. $TYR launches on{" "}
            <a href="https://docs.ponsfamily.com/" target="_blank" rel="noopener noreferrer">
              pons
            </a>
            .
          </p>
          <div className="foot-ca-section">
            <span className="foot-ca-label">Official Token Contract</span>
            <CaBadge variant="footer" />
          </div>
          <div className="foot-row">
            <a
              className="icon-btn"
              href="https://x.com/TYRIAN_HANDLE"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Tyrian on X"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L1.9 3h6.4l4.4 5.8L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z"
                />
              </svg>
            </a>
          </div>
        </div>
        <p className="legal">
          $TYR is a utility access token, not an investment. Quota is not fixed and depends on yield and fees. Stock
          Tokens are not available in the US, UK, Canada, Switzerland or UAE. Tyrian is independent and not affiliated
          with Robinhood or pons. Check the official contract address on this site before trading.
        </p>
      </div>
    </footer>
  );
}
