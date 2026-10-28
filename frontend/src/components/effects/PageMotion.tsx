"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * Global equivalent of the template's `motion()` helper.
 *
 * It runs once per route and only touches page-level elements, so the
 * homepage's richer timeline can stay in `app/page.tsx`.
 */
export function PageMotion() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") return;

    gsap.registerPlugin(ScrollTrigger);

    const RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (RM) return;

    const fine = window.matchMedia("(hover:hover) and (pointer:fine)").matches;
    const restores: Array<() => void> = [];
    let cancelled = false;
    let refreshFrame = 0;

    const ctx = gsap.context(() => {
      /* ---------- page title: per-word mask rise ---------- */
      document.querySelectorAll<HTMLElement>(".page-head h1").forEach((heading) => {
        const original = heading.innerHTML;
        const label = (heading.textContent || "").replace(/\s+/g, " ").trim();
        if (!label) return;

        const words = label.split(" ");
        heading.setAttribute("aria-label", label);
        heading.textContent = "";

        words.forEach((word, index) => {
          const mask = document.createElement("span");
          mask.setAttribute("aria-hidden", "true");
          mask.style.cssText =
            "display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.08em";

          const inner = document.createElement("span");
          inner.className = "w";
          inner.style.cssText = "display:inline-block";
          inner.textContent = word;

          mask.appendChild(inner);
          heading.appendChild(mask);
          if (index < words.length - 1) heading.appendChild(document.createTextNode(" "));
        });

        restores.push(() => {
          heading.innerHTML = original;
          heading.removeAttribute("aria-label");
        });

        gsap.from(heading.querySelectorAll(".w"), {
          yPercent: 110,
          duration: 0.8,
          ease: "power3.out",
          stagger: 0.05,
          delay: 0.1,
        });
      });

      const headMeta = document.querySelectorAll(
        ".page-head .eyebrow, .page-head .lead, .page-head .aside"
      );
      if (headMeta.length) {
        gsap.from(headMeta, {
          y: 18,
          opacity: 0,
          duration: 0.7,
          ease: "power3.out",
          stagger: 0.06,
          delay: 0.2,
        });
      }

      /* ---------- scroll reveals ---------- */
      document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
        gsap.from(el, {
          y: 26,
          opacity: 0,
          duration: 0.7,
          ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 92%", once: true },
        });
      });

      /* ---------- text scramble ---------- */
      document.querySelectorAll<HTMLElement>(".scramble[data-text]").forEach((el) => {
        const final = el.dataset.text || "";
        const glyphs = "!<>-_\\/[]{}=+*^?#01ABCDEF";

        ScrollTrigger.create({
          trigger: el,
          start: "top 85%",
          once: true,
          onEnter: () => {
            let frame = 0;
            const total = 40;

            const tick = () => {
              if (cancelled) return;
              el.textContent = [...final]
                .map((char, index) => {
                  if (char === " ") return " ";
                  return frame / total > index / final.length + 0.15
                    ? char
                    : glyphs[Math.floor(Math.random() * glyphs.length)];
                })
                .join("");

              if (frame++ < total + 8) requestAnimationFrame(tick);
              else el.textContent = final;
            };

            tick();
          },
        });
      });

      /* ---------- card tilt + shine (stake, home, inner cards) ---------- */
      if (fine) {
        document.querySelectorAll<HTMLElement>(".tilt").forEach((wrap) => {
          if (wrap.dataset.tiltOn === "1") return;
          const card = wrap.firstElementChild as HTMLElement | null;
          if (!card) return;

          wrap.dataset.tiltOn = "1";
          const rX = gsap.quickTo(card, "rotationX", { duration: 0.5, ease: "power3.out" });
          const rY = gsap.quickTo(card, "rotationY", { duration: 0.5, ease: "power3.out" });

          const onMove = (event: MouseEvent) => {
            if ((event.target as HTMLElement)?.closest("input,button,select")) return;
            const rect = card.getBoundingClientRect();
            const px = (event.clientX - rect.left) / rect.width;
            const py = (event.clientY - rect.top) / rect.height;

            rY((px - 0.5) * 8);
            rX((0.5 - py) * 7);
            card.style.setProperty("--mx", `${px * 100}%`);
            card.style.setProperty("--my", `${py * 100}%`);
          };

          const onLeave = () => {
            rX(0);
            rY(0);
          };

          wrap.addEventListener("mousemove", onMove);
          wrap.addEventListener("mouseleave", onLeave);
          restores.push(() => {
            wrap.removeEventListener("mousemove", onMove);
            wrap.removeEventListener("mouseleave", onLeave);
            delete wrap.dataset.tiltOn;
            gsap.killTweensOf(card);
          });
        });
      }

      /* ---------- quota ring: draw in when it enters the viewport ---------- */
      document.querySelectorAll<SVGCircleElement>("[data-ring-animate]").forEach((ring) => {
        const dash = parseFloat(ring.getAttribute("stroke-dasharray") || "540.35");
        const target = parseFloat(
          ring.dataset.ringTarget ||
            ring.style.strokeDashoffset ||
            ring.getAttribute("stroke-dashoffset") ||
            "0"
        );
        if (!Number.isFinite(dash) || !Number.isFinite(target)) return;

        ring.style.transition = "none";
        ring.style.strokeDashoffset = `${dash}px`;
        void ring.getBoundingClientRect();
        ring.style.transition = "stroke-dashoffset .9s cubic-bezier(.16,1,.3,1)";

        const observer = new IntersectionObserver(
          (entries) => {
            if (!entries[0]?.isIntersecting) return;
            ring.style.strokeDashoffset = `${target}px`;
            observer.disconnect();
          },
          { threshold: 0.35 }
        );

        observer.observe(ring);
        restores.push(() => observer.disconnect());
      });

      /* ---------- chart line draw ---------- */
      document.querySelectorAll<SVGPathElement>("[data-chart-line]").forEach((path) => {
        let length = 0;
        try {
          length = path.getTotalLength();
        } catch {
          return;
        }
        if (!length) return;

        gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
        gsap.to(path, {
          strokeDashoffset: 0,
          duration: 1.25,
          ease: "power2.out",
          scrollTrigger: {
            trigger: path.closest(".chart") || path,
            start: "top 85%",
            once: true,
          },
          onComplete: () => {
            gsap.set(path, { clearProps: "strokeDasharray,strokeDashoffset" });
          },
        });
      });

      /* ---------- bar charts and meters ---------- */
      const chartBars = document.querySelectorAll<SVGPathElement>("[data-chart-bars] .bar");
      if (chartBars.length) {
        gsap.from(chartBars, {
          scaleY: 0,
          transformOrigin: "bottom center",
          duration: 0.7,
          ease: "power3.out",
          stagger: 0.02,
          scrollTrigger: {
            trigger: chartBars[0].closest(".chart") || chartBars[0],
            start: "top 85%",
            once: true,
          },
        });
      }

      const growBars = document.querySelectorAll<HTMLElement>(
        ".page-dashboard .sharebar i, .page-treasury .bucket .bar i"
      );
      if (growBars.length) {
        gsap.from(growBars, {
          scaleX: 0,
          transformOrigin: "left center",
          duration: 0.8,
          ease: "expo.out",
          stagger: 0.05,
          scrollTrigger: {
            trigger: growBars[0].closest(".panel, .tiles") || growBars[0],
            start: "top 88%",
            once: true,
          },
        });
      }

      refreshFrame = requestAnimationFrame(() => ScrollTrigger.refresh());
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(refreshFrame);
      ctx.revert();
      restores.forEach((restore) => restore());
    };
  }, [pathname]);

  return null;
}
