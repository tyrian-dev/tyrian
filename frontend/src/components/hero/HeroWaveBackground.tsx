"use client";

import { useEffect, useRef } from "react";

const VIDEO_URL = "/hero-wave.mp4";
const POSTER_URL = "/hero-poster.jpg";

export function HeroWaveBackground() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    // Explicitly set muted DOM property for 100% browser autoplay policy compliance
    video.defaultMuted = true;
    video.muted = true;

    // Trigger instant video playback
    video.play().catch(() => {});

    // User gesture fallback for strict browser autoplay policies
    const onUserInteraction = () => {
      if (video && video.paused) {
        video.play().catch(() => {});
      }
      window.removeEventListener("click", onUserInteraction);
      window.removeEventListener("touchstart", onUserInteraction);
    };

    window.addEventListener("click", onUserInteraction, { once: true, passive: true });
    window.addEventListener("touchstart", onUserInteraction, { once: true, passive: true });

    return () => {
      window.removeEventListener("click", onUserInteraction);
      window.removeEventListener("touchstart", onUserInteraction);
    };
  }, []);

  return (
    <div className="hero-wave-container" aria-hidden="true">
      {/* 1. Base Poster Fallback */}
      <div
        className="hero-wave-poster"
        style={{ backgroundImage: `url(${POSTER_URL})` }}
      />

      {/* 2. Self-Hosted Hardware-Accelerated Looping 3D Wave Video */}
      <video
        ref={videoRef}
        className="hero-wave-video"
        src={VIDEO_URL}
        poster={POSTER_URL}
        muted
        loop
        autoPlay
        playsInline
        preload="auto"
        aria-hidden="true"
      />

      {/* 3. Tyrian Color Grade & Blend Overlay */}
      <div className="hero-wave-tint" />

      {/* 4. Frosted Glass Depth Overlay (2px blur + dark mask) */}
      <div className="hero-wave-overlay" />

      {/* 5. Ambient Glow Orbs (Tyrian Imperial Purple & Antique Gold) */}
      <div className="hero-glow-orb orb-top-purple" />
      <div className="hero-glow-orb orb-bottom-gold" />

      {/* 6. Bottom Vignette Gradient to Page Body */}
      <div className="hero-wave-vignette" />
    </div>
  );
}
