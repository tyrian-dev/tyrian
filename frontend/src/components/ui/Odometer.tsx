"use client";

import { createElement, useEffect, useLayoutEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

type OdometerProps = {
  text: string;
  className?: string;
  step?: number;
  as?: "span" | "div";
  /** The homepage uses a slightly slower roll than the inner pages. */
  variant?: "home" | "inner";
};

const DIGITS = "01234567890123456789".split("");
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Odometer markup matching the template's `.odo` structure.
 *
 * The server render shows the final value so the number remains readable
 * without JavaScript. On the client the columns are reset to the first digit
 * in a layout effect, before the browser paints, then rolled to the target.
 */
export function Odometer({
  text,
  className = "",
  step = 1.1,
  as = "span",
  variant = "inner",
}: OdometerProps) {
  const root = useRef<HTMLElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.registerPlugin(ScrollTrigger);

    const columns = Array.from(el.querySelectorAll<HTMLElement>(".col > span"));
    if (!columns.length) return;

    const isHome = variant === "home";
    const ctx = gsap.context(() => {
      // This must run before paint. Otherwise the server-rendered final value
      // is visible for one frame and then jumps back to zero.
      gsap.set(columns, { y: 0 });
      gsap.to(columns, {
        y: (index) => {
          const digit = Number((columns[index].parentElement as HTMLElement | null)?.dataset.d || 0);
          return `-${(digit + 10) * step}em`;
        },
        duration: (index) => (isHome ? 1.6 + index * 0.12 : 1.4 + index * 0.08),
        delay: (index) => (isHome ? index * 0.05 : index * 0.03),
        ease: "expo.out",
        scrollTrigger: {
          trigger: el,
          start: isHome ? "top 88%" : "top 92%",
          once: true,
        },
      });
    }, el);

    return () => ctx.revert();
  }, [text, step, variant]);

  const children = Array.from(text).map((ch, index) => {
    if (/\d/.test(ch)) {
      return (
        <span className="col" aria-hidden="true" data-d={ch} key={`${ch}-${index}`}>
          <span style={{ transform: `translateY(-${Number(ch) * step}em)` }}>
            {DIGITS.map((digit, i) => (
              <i key={`${digit}-${i}`}>{digit}</i>
            ))}
          </span>
        </span>
      );
    }

    return (
      <span aria-hidden="true" key={`${ch}-${index}`}>
        {ch === " " ? "\u00A0" : ch}
      </span>
    );
  });

  return createElement(
    as,
    {
      ref: root,
      className: `odo ${className}`.trim(),
      "aria-label": text,
    },
    children
  );
}
