"use client";

import React, { useEffect, useRef } from "react";

interface GlobePoint {
  lat: number;
  lng: number;
}

// Decorative points only: they do not represent Syncbay regions or POPs.
const GLOBE_POINTS: GlobePoint[] = [
  { lat: 38.9, lng: -77.4 },
  { lat: 37.7, lng: -122.4 },
  { lat: 50.1, lng: 8.7 },
  { lat: 51.5, lng: -0.1 },
  { lat: 1.3, lng: 103.8 },
  { lat: -33.9, lng: 151.2 },
];

const CONNECTIONS = [
  [0, 1], [0, 2], [0, 3], [2, 3], [2, 4], [4, 5], [0, 4], [1, 5], [3, 4],
];

function latLngTo3D(lat: number, lng: number, radius: number): [number, number, number] {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return [
    -(radius * Math.sin(phi) * Math.cos(theta)),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

function project(x: number, y: number, z: number, cx: number, cy: number, fov: number): [number, number, number] {
  const scale = fov / (fov + z);
  return [x * scale + cx, y * scale + cy, scale];
}

function rotateY(x: number, y: number, z: number, angle: number): [number, number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [x * cos - z * sin, y, x * sin + z * cos];
}

function rotateX(x: number, y: number, z: number, angle: number): [number, number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [x, y * cos - z * sin, y * sin + z * cos];
}

export function Globe3D({ size = 400, className = "" }: { size?: number; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    const radius = size * 0.35;
    const fov = 600;
    let time = 0;
    let animId: number;

    const render = () => {
      time += 0.003;
      ctx.clearRect(0, 0, size, size);

      const tiltX = -0.3;
      const rotYAngle = time;

      // Draw wireframe sphere — latitude lines
      ctx.strokeStyle = "rgba(124, 58, 237, 0.12)";
      ctx.lineWidth = 0.5;

      for (let lat = -80; lat <= 80; lat += 20) {
        ctx.beginPath();
        let first = true;
        for (let lng = 0; lng <= 360; lng += 5) {
          let [px, py, pz] = latLngTo3D(lat, lng, radius);
          [px, py, pz] = rotateY(px, py, pz, rotYAngle);
          [px, py, pz] = rotateX(px, py, pz, tiltX);
          const [sx, sy] = project(px, py, pz, cx, cy, fov);
          if (first) { ctx.moveTo(sx, sy); first = false; }
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }

      // Longitude lines
      for (let lng = 0; lng < 360; lng += 20) {
        ctx.beginPath();
        let first = true;
        for (let lat = -90; lat <= 90; lat += 5) {
          let [px, py, pz] = latLngTo3D(lat, lng, radius);
          [px, py, pz] = rotateY(px, py, pz, rotYAngle);
          [px, py, pz] = rotateX(px, py, pz, tiltX);
          const [sx, sy] = project(px, py, pz, cx, cy, fov);
          if (first) { ctx.moveTo(sx, sy); first = false; }
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }

      // Draw connections (arcs)
      for (const [i, j] of CONNECTIONS) {
        const p1 = GLOBE_POINTS[i];
        const p2 = GLOBE_POINTS[j];
        ctx.beginPath();
        ctx.strokeStyle = "rgba(6, 182, 212, 0.35)";
        ctx.lineWidth = 1.5;

        const steps = 30;
        let first = true;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const lat = p1.lat + (p2.lat - p1.lat) * t;
          const lng = p1.lng + (p2.lng - p1.lng) * t;
          const arcHeight = 1 + Math.sin(t * Math.PI) * 0.15;
          let [px, py, pz] = latLngTo3D(lat, lng, radius * arcHeight);
          [px, py, pz] = rotateY(px, py, pz, rotYAngle);
          [px, py, pz] = rotateX(px, py, pz, tiltX);
          if (pz > -100) {
            const [sx, sy] = project(px, py, pz, cx, cy, fov);
            if (first) { ctx.moveTo(sx, sy); first = false; }
            else ctx.lineTo(sx, sy);
          }
        }
        ctx.stroke();

        // Animated pulse along arc
        const pulseT = (time * 8 + i * 0.7) % 1;
        const pLat = p1.lat + (p2.lat - p1.lat) * pulseT;
        const pLng = p1.lng + (p2.lng - p1.lng) * pulseT;
        const arcH = 1 + Math.sin(pulseT * Math.PI) * 0.15;
        let [ppx, ppy, ppz] = latLngTo3D(pLat, pLng, radius * arcH);
        [ppx, ppy, ppz] = rotateY(ppx, ppy, ppz, rotYAngle);
        [ppx, ppy, ppz] = rotateX(ppx, ppy, ppz, tiltX);
        if (ppz > -100) {
          const [sx, sy, sc] = project(ppx, ppy, ppz, cx, cy, fov);
          ctx.beginPath();
          ctx.arc(sx, sy, 3 * sc, 0, Math.PI * 2);
          ctx.fillStyle = "#06B6D4";
          ctx.globalAlpha = 0.9;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(sx, sy, 8 * sc, 0, Math.PI * 2);
          ctx.fillStyle = "#06B6D4";
          ctx.globalAlpha = 0.2;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // Draw POP nodes
      for (const pop of GLOBE_POINTS) {
        let [px, py, pz] = latLngTo3D(pop.lat, pop.lng, radius);
        [px, py, pz] = rotateY(px, py, pz, rotYAngle);
        [px, py, pz] = rotateX(px, py, pz, tiltX);

        const [sx, sy, sc] = project(px, py, pz, cx, cy, fov);
        const isFront = pz < 100;

        if (isFront) {
          // Outer glow
          ctx.beginPath();
          ctx.arc(sx, sy, 12 * sc, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(6, 182, 212, 0.15)";
          ctx.fill();

          // Pulsing ring
          const pulseSize = 6 + Math.sin(time * 4 + GLOBE_POINTS.indexOf(pop)) * 2;
          ctx.beginPath();
          ctx.arc(sx, sy, pulseSize * sc, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(6, 182, 212, 0.4)";
          ctx.lineWidth = 1;
          ctx.stroke();

          // Core dot
          ctx.beginPath();
          ctx.arc(sx, sy, 3 * sc, 0, Math.PI * 2);
          ctx.fillStyle = "#06B6D4";
          ctx.fill();

        }
      }

      // Ambient glow in center
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.2);
      grad.addColorStop(0, "rgba(124, 58, 237, 0.05)");
      grad.addColorStop(0.5, "rgba(6, 182, 212, 0.03)");
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);

      animId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animId);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size }}
    />
  );
}
