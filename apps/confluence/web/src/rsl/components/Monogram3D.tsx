"use client";

/**
 * Signature 3D: the rsL monogram extruded (SVGLoader → ExtrudeGeometry), blue→violet body with a
 * cyan accent face, studio lighting, idle turn 0.1 rad/s, pointer tilt ≤ 8°. About / splash /
 * empty states only. Pixel ratio ≤ 2; pauses off-screen or when the tab is hidden; disposes on
 * unmount. Reduced motion → one still frame. No WebGL → the static SVG mark (identity skill §5).
 */
import { useEffect, useRef, useState } from "react";
import { monogramSVG } from "@rsl/core-kit/core/rsl-brand.js";

const MAIN = ["M0 250V112C0 69 27 42 70 42H172V85H70C52 85 43 96 43 114V250Z", "M69 129C69 115 79 107 92 107H124C166 107 193 137 193 179C193 222 167 250 124 250H69V207H122C140 207 150 197 150 179C150 161 140 150 122 150H92C79 150 69 143 69 129Z", "M199 0H245V160L199 114Z", "M199 177H245V207H340V250H244C215 250 199 234 199 205Z"];
const ACCENT = "M147 120H190L236 165H193Z";

export function Monogram3D({ size = 180, fallbackLabel }: { size?: number; fallbackLabel?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const probe = document.createElement("canvas");
      const probeGl = (probe.getContext("webgl2") || probe.getContext("webgl")) as WebGLRenderingContext | null;
      if (!probeGl) { setFallback(true); return; }
      // Release the probe context at once (review S17): repeated opens must not pile up contexts.
      probeGl.getExtension("WEBGL_lose_context")?.loseContext();
      const THREE = await import("three");
      const { SVGLoader } = await import("three/examples/jsm/loaders/SVGLoader.js");
      if (disposed) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(size, size);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      el.appendChild(renderer.domElement);
      renderer.domElement.setAttribute("aria-hidden", "true");

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
      camera.position.set(0, 0, 720);
      scene.add(new THREE.HemisphereLight(0xdde8ff, 0x0b1b33, 1.2));
      const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(300, 400, 600); scene.add(key);
      const rim = new THREE.DirectionalLight(0x00d9f5, 1.1); rim.position.set(-400, -200, -300); scene.add(rim);

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 250">${MAIN.map((d) => `<path d="${d}" fill="#0755F5"/>`).join("")}<path d="${ACCENT}" fill="#00D9F5"/></svg>`;
      const data = new SVGLoader().parse(svg);
      const group = new THREE.Group();
      const depth = 250 * 0.12;
      const blue = new THREE.Color("#0755F5"), violet = new THREE.Color("#7524F4");
      const geoms: import("three").BufferGeometry[] = [];
      const mats: import("three").Material[] = [];
      data.paths.forEach((p, idx) => {
        const accent = idx === data.paths.length - 1;
        for (const shape of SVGLoader.createShapes(p)) {
          const g = new THREE.ExtrudeGeometry(shape, { depth: accent ? depth * 1.15 : depth, bevelEnabled: true, bevelThickness: 3, bevelSize: 2.2, bevelSegments: 3, curveSegments: 10 });
          if (!accent) {
            const pos = g.getAttribute("position");
            const colors = new Float32Array(pos.count * 3);
            for (let i = 0; i < pos.count; i++) { const c = blue.clone().lerp(violet, Math.min(1, Math.max(0, pos.getX(i) / 340))); colors.set([c.r, c.g, c.b], i * 3); }
            g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
          }
          const m = new THREE.MeshPhysicalMaterial(accent ? { color: 0x00d9f5, metalness: 0.2, roughness: 0.25, clearcoat: 0.8, emissive: 0x003a44 } : { vertexColors: true, metalness: 0.35, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.15 });
          geoms.push(g); mats.push(m);
          group.add(new THREE.Mesh(g, m));
        }
      });
      group.scale.set(1, -1, 1); // SVG y-down → three y-up
      const box = new THREE.Box3().setFromObject(group);
      const center = box.getCenter(new THREE.Vector3());
      group.position.sub(center);
      const pivot = new THREE.Group(); pivot.add(group); scene.add(pivot);

      let tiltX = 0, tiltY = 0, visible = true, raf = 0, last = performance.now(), angle = 0;
      const MAX_TILT = (8 * Math.PI) / 180;
      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        tiltY = (((e.clientX - r.left) / r.width) - 0.5) * 2 * MAX_TILT;
        tiltX = (((e.clientY - r.top) / r.height) - 0.5) * 2 * MAX_TILT;
      };
      const frame = (now: number) => {
        const dt = (now - last) / 1000; last = now;
        if (!reduce) angle += 0.1 * dt;
        pivot.rotation.set(tiltX, angle + tiltY, 0);
        if (disposed) return;
        renderer.render(scene, camera);
        if (!reduce && visible && !document.hidden) raf = requestAnimationFrame(frame);
      };
      const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !reduce) { last = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); } });
      io.observe(el);
      const onVis = () => { if (!document.hidden && visible && !reduce) { last = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); } };
      document.addEventListener("visibilitychange", onVis);
      if (!reduce) el.addEventListener("pointermove", onMove);
      raf = requestAnimationFrame(frame);

      let cleaned = false;
      cleanup = () => {
        // Idempotent: releasing an already-lost context makes Chromium log CONTEXT_LOST_WEBGL.
        if (cleaned) return;
        cleaned = true;
        cancelAnimationFrame(raf); io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        el.removeEventListener("pointermove", onMove);
        geoms.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose());
        const gl = renderer.getContext();
        if (gl && !gl.isContextLost()) renderer.forceContextLoss();
        renderer.dispose(); renderer.domElement.remove();
      };
      if (disposed) cleanup();
    })().catch(() => setFallback(true));
    return () => { disposed = true; cleanup(); };
  }, [size]);

  if (fallback) {
    return (
      <div style={{ width: size, height: size }} className="flex items-center justify-center" title={fallbackLabel}>
        <div className="w-3/4" dangerouslySetInnerHTML={{ __html: monogramSVG({ className: "rsl-mono w-full h-auto" }) }} />
      </div>
    );
  }
  return <div ref={host} style={{ width: size, height: size }} className="mx-auto" data-testid="rsl-monogram-3d" />;
}
