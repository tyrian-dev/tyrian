"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

declare global {
  interface Window {
    __lenis?: Lenis;
    __tyr?: {
      scroll: number;
      velocity: number;
      mx: number;
      my: number;
      RM?: boolean;
    };
  }
}

export function SmoothScroll() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") return;

    gsap.registerPlugin(ScrollTrigger);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isHome = pathname === "/";
    window.__tyr = window.__tyr || {
      scroll: 0,
      velocity: 0,
      mx: 0,
      my: 0,
    };
    window.__tyr.RM = reducedMotion;

    const handleAnchorClick = (e: MouseEvent, lenis?: Lenis) => {
      const target = (e.target as HTMLElement)?.closest('a[href^="#"]');
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href || href === "#") return;
      const el = document.querySelector(href);
      if (!el) return;
      e.preventDefault();
      if (lenis) {
        // The template uses a longer, eased scroll without an offset on the
        // homepage, and a fixed 90px offset for inner-page anchors.
        lenis.scrollTo(
          el as HTMLElement,
          isHome
            ? { duration: 1.4, easing: (x: number) => 1 - Math.pow(1 - x, 4) }
            : { offset: -90, duration: 1.2 },
        );
      } else {
        window.scrollTo({
          top:
            window.scrollY +
            (el as HTMLElement).getBoundingClientRect().top -
            (isHome ? 0 : 90),
          behavior: "auto",
        });
      }
    };

    // Respect the OS setting: native scrolling, no inertial layer, no
    // scroll-driven ticker. The template skips Lenis entirely in this case.
    if (reducedMotion) {
      const onAnchor = (e: MouseEvent) => handleAnchorClick(e);
      document.addEventListener("click", onAnchor);
      return () => {
        document.removeEventListener("click", onAnchor);
        delete window.__lenis;
      };
    }

    const lenis = new Lenis({
      lerp: pathname === "/" ? 0.09 : 0.1,
      smoothWheel: true,
    });
    window.__lenis = lenis;

    lenis.on("scroll", (e: Lenis) => {
      ScrollTrigger.update();
      if (window.__tyr) {
        window.__tyr.velocity = e.velocity || 0;
      }
    });

    const raf = (time: number) => {
      lenis.raf(time * 1000);
    };

    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    const onAnchor = (e: MouseEvent) => handleAnchorClick(e, lenis);
    document.addEventListener("click", onAnchor);

    return () => {
      gsap.ticker.remove(raf);
      document.removeEventListener("click", onAnchor);
      lenis.destroy();
      delete window.__lenis;
    };
  }, [pathname]);

  return null;
}
