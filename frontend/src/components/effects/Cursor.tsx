"use client";

import { useEffect } from "react";
import gsap from "gsap";

export function Cursor() {
  useEffect(() => {
    const ring = document.getElementById("cursor");
    const dot = document.getElementById("cursorDot");
    if (!ring || !dot) return;

    const fine = window.matchMedia("(hover:hover) and (pointer:fine)").matches;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reducedMotion) return;

    const rx = gsap.quickTo(ring, "x", { duration: 0.45, ease: "power3.out" });
    const ry = gsap.quickTo(ring, "y", { duration: 0.45, ease: "power3.out" });
    const dx = gsap.quickTo(dot, "x", { duration: 0.08 });
    const dy = gsap.quickTo(dot, "y", { duration: 0.08 });

    const handleMove = (event: MouseEvent) => {
      ring.classList.add("on");
      dot.classList.add("on");
      rx(event.clientX);
      ry(event.clientY);
      dx(event.clientX);
      dy(event.clientY);

      if (window.__tyr) {
        window.__tyr.mx = (event.clientX / window.innerWidth) * 2 - 1;
        window.__tyr.my = (event.clientY / window.innerHeight) * 2 - 1;
      }
    };

    const handleOver = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest(
        "a, button, input, select, textarea, summary, [role=tab], [data-cursor]"
      );
      ring.classList.toggle("is-link", Boolean(target));
    };

    window.addEventListener("mousemove", handleMove, { passive: true });
    document.addEventListener("mouseover", handleOver);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseover", handleOver);
      gsap.killTweensOf([ring, dot]);
      ring.classList.remove("on", "is-link", "is-label");
      dot.classList.remove("on");
    };
  }, []);

  return (
    <>
      <div className="cursor" id="cursor" aria-hidden="true">
        <span>SCROLL</span>
      </div>
      <div className="cursor-dot" id="cursorDot" aria-hidden="true" />
    </>
  );
}
