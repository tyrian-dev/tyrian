"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ParametricGeometry } from "three/examples/jsm/geometries/ParametricGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export function MurexCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0, 9);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    // RoomEnvironment from r160 uses intensity 5 when no renderer is passed,
    // matching the static tyrian-site hero. Passing the r186 renderer would
    // switch the environment to its legacy-light scale (900) and blow out the
    // shell.
    const environment = pmrem.fromScene(room, 0.04).texture;
    scene.environment = environment;
    room.dispose();

    /* --- murex shell: conical spiral tube with spines --- */
    const TURNS = 4.2;
    function shell(u: number, v: number, target: THREE.Vector3) {
      const t = v;
      const theta = t * TURNS * Math.PI * 2;
      const phi = u * Math.PI * 2;
      const g = Math.pow(t, 1.55);
      const rs = 0.06 + 1.05 * g; // spiral radius
      const y = 1.9 - 3.6 * Math.pow(t, 0.9); // apex up, aperture down
      let rt = 0.03 + 0.62 * g; // tube radius
      const varix = Math.pow(Math.max(0, Math.sin(theta * 3)), 14);
      const outer = Math.max(0, Math.cos(phi - 0.3));
      const ribs = 0.06 * Math.pow(Math.max(0, Math.sin(phi * 7)), 4);
      rt *= 1 + varix * outer * 0.85 + ribs * (1 - varix);

      const radial = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
      const cx = rs * radial.x;
      const cz = rs * radial.z;
      const px = cx + rt * Math.cos(phi) * radial.x;
      const pz = cz + rt * Math.cos(phi) * radial.z;
      const py = y + rt * Math.sin(phi) * 1.15;
      target.set(px, py, pz);
    }

    const geo = new ParametricGeometry(shell, 96, 720);
    geo.computeVertexNormals();

    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const cA = new THREE.Color("#2A0118");
    const cB = new THREE.Color("#8A1257");
    const cG = new THREE.Color("#C9A24A");
    const tmp = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const k = THREE.MathUtils.clamp((1.9 - y) / 3.8, 0, 1);
      tmp.copy(cA).lerp(cB, Math.pow(k, 0.8));
      const band = Math.pow(Math.abs(Math.sin(y * 9)), 40);
      tmp.lerp(cG, band * 0.55);
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));

    const mat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.48,
      metalness: 0.08,
      clearcoat: 0.5,
      clearcoatRoughness: 0.35,
      sheen: 0.4,
      sheenColor: new THREE.Color("#D178A6"),
      sheenRoughness: 0.6,
      iridescence: 0.12,
      iridescenceIOR: 1.3,
      side: THREE.DoubleSide,
    });
    const shellMesh = new THREE.Mesh(geo, mat);
    const group = new THREE.Group();
    group.add(shellMesh);
    group.rotation.set(0.35, 0, -0.55);
    scene.add(group);

    /* gold spiral thread orbiting the shell */
    const pts = [];
    for (let i = 0; i <= 600; i++) {
      const t = i / 600;
      const a = t * Math.PI * 2 * 5.5;
      const r = 1.55 + 0.35 * Math.sin(t * Math.PI);
      pts.push(
        new THREE.Vector3(
          Math.cos(a) * r * (1 - t * 0.35),
          2.4 - t * 4.8,
          Math.sin(a) * r * (1 - t * 0.35)
        )
      );
    }
    const thread = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 900, 0.008, 6),
      new THREE.MeshStandardMaterial({
        color: "#E4CB8A",
        emissive: "#C9A24A",
        emissiveIntensity: 0.25,
        metalness: 1,
        roughness: 0.25,
        transparent: true,
        opacity: 0.75,
      })
    );
    group.add(thread);

    /* dye dust particles */
    const N = 900;
    const pg = new THREE.BufferGeometry();
    const pp = new Float32Array(N * 3);
    const seeds = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = 2.4 + Math.random() * 4.5;
      const a = Math.random() * Math.PI * 2;
      pp.set([Math.cos(a) * r, (Math.random() - 0.5) * 7, Math.sin(a) * r - 1.5], i * 3);
      seeds[i] = Math.random();
    }
    pg.setAttribute("position", new THREE.BufferAttribute(pp, 3));
    const dust = new THREE.Points(
      pg,
      new THREE.PointsMaterial({
        color: "#E4CB8A",
        size: 0.028,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    scene.add(dust);

    /* lights */
    scene.add(new THREE.AmbientLight("#3D0224", 0.6));
    const key = new THREE.DirectionalLight("#F5E3B8", 2.6);
    key.position.set(4, 5, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight("#B03A7A", 3.2);
    rim.position.set(-6, -2, -4);
    scene.add(rim);
    const fill = new THREE.PointLight("#C9A24A", 6, 12);
    fill.position.set(2, -2.5, 3);
    scene.add(fill);

    function resize() {
      if (!canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const wide = w > 860;
      group.position.set(wide ? 2.15 : 1.15, wide ? -0.15 : -2.05, wide ? 0 : -1);
      group.scale.setScalar(wide ? 0.9 : 0.62);
      canvas.style.opacity = wide ? "" : "0.85";
      shellMesh.material.opacity = 1;
      if (reducedMotion) renderer.render(scene, camera);
    }

    window.addEventListener("resize", resize);
    resize();

    let visible = true;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(canvas);

    const clock = new THREE.Clock();
    let rx = 0;
    let ry = 0;
    let animId = 0;
    let disposed = false;

    const handleMouseMove = (e: MouseEvent) => {
      const mx = (e.clientX / window.innerWidth) * 2 - 1;
      const my = (e.clientY / window.innerHeight) * 2 - 1;
      if (window.__tyr) {
        window.__tyr.mx = mx;
        window.__tyr.my = my;
      }
    };
    window.addEventListener("mousemove", handleMouseMove, { passive: true });

    function renderFrame(scrollProgress: number, mouseX: number, mouseY: number, elapsed: number) {
      rx += (mouseY * 0.25 - rx) * 0.05;
      ry += (mouseX * 0.45 - ry) * 0.05;

      shellMesh.rotation.y = elapsed * 0.18 + scrollProgress * 3.2;
      group.rotation.x = 0.35 + rx + scrollProgress * 0.4;
      group.rotation.z = -0.55 + ry * 0.3;
      group.rotation.y = ry;
      thread.rotation.y = -elapsed * 0.12;
      dust.rotation.y = elapsed * 0.03;

      camera.position.z = 9 - scrollProgress * 2.2;
      camera.position.y = scrollProgress * -1.2;

      const p = pg.attributes.position.array as Float32Array;
      for (let i = 0; i < N; i++) {
        p[i * 3 + 1] += 0.002 + seeds[i] * 0.003;
        if (p[i * 3 + 1] > 3.5) p[i * 3 + 1] = -3.5;
      }
      pg.attributes.position.needsUpdate = true;

      renderer.render(scene, camera);
    }

    if (reducedMotion) {
      const state = window.__tyr;
      renderFrame(state?.scroll || 0, state?.mx || 0, state?.my || 0, 0);
    } else {
      function frame() {
        if (disposed) return;
        const t = clock.getElapsedTime();
        if (visible) {
          const state = window.__tyr || { scroll: 0, mx: 0, my: 0 };
          renderFrame(state.scroll || 0, state.mx || 0, state.my || 0, t);
        }
        animId = requestAnimationFrame(frame);
      }
      animId = requestAnimationFrame(frame);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", handleMouseMove);
      observer.disconnect();

      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => material.dispose());
        } else {
          mesh.material?.dispose();
        }
      });

      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      // Do not call forceContextLoss() here: React StrictMode mounts effects
      // twice in development, and a force-lost context cannot be reused by the
      // second renderer, which leaves the hero canvas opaque white.
    };
  }, []);

  return <canvas ref={canvasRef} id="gl" aria-hidden="true" />;
}
