"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";

interface DeepSpaceSceneProps {
  mode?: "full" | "subtle" | "hero";
  interactive?: boolean;
}

export function DeepSpaceScene({
  mode = "full",
  interactive = true,
}: DeepSpaceSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    const container = mountRef.current;
    if (!container) return;

    // --- Scene Setup ---
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050510, 0.0008);

    const camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      2500
    );
    camera.position.z = mode === "hero" ? 450 : 600;

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // --- Starfield Generation ---
    const starCount = mode === "subtle" ? 1200 : 3500;
    const starGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);
    const starVelocities = new Float32Array(starCount);

    const palette = [
      new THREE.Color(0x06b6d4), // Cyan
      new THREE.Color(0x8b5cf6), // Violet
      new THREE.Color(0x3b82f6), // Electric Blue
      new THREE.Color(0xec4899), // Pink
      new THREE.Color(0xffffff), // Pure White
      new THREE.Color(0xa7f3d0), // Mint
    ];

    for (let i = 0; i < starCount; i++) {
      const idx = i * 3;
      starPositions[idx] = (Math.random() - 0.5) * 2000;
      starPositions[idx + 1] = (Math.random() - 0.5) * 2000;
      starPositions[idx + 2] = (Math.random() - 0.5) * 2000;

      const color = palette[Math.floor(Math.random() * palette.length)];
      starColors[idx] = color.r;
      starColors[idx + 1] = color.g;
      starColors[idx + 2] = color.b;

      starVelocities[i] = Math.random() * 1.5 + 0.4;
    }

    starGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(starPositions, 3)
    );
    starGeometry.setAttribute("color", new THREE.BufferAttribute(starColors, 3));

    // Custom circle star texture for crisp 4K rendering
    const starCanvas = document.createElement("canvas");
    starCanvas.width = 32;
    starCanvas.height = 32;
    const starCtx = starCanvas.getContext("2d");
    if (starCtx) {
      const gradient = starCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.3, "rgba(255,255,255,0.8)");
      gradient.addColorStop(0.7, "rgba(255,255,255,0.2)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      starCtx.fillStyle = gradient;
      starCtx.fillRect(0, 0, 32, 32);
    }
    const starTexture = new THREE.CanvasTexture(starCanvas);

    const starMaterial = new THREE.PointsMaterial({
      size: mode === "subtle" ? 2.5 : 3.8,
      vertexColors: true,
      map: starTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const starField = new THREE.Points(starGeometry, starMaterial);
    scene.add(starField);

    // --- Nebula Glow Particles ---
    const nebulaCount = mode === "subtle" ? 8 : 18;
    const nebulaGroup = new THREE.Group();

    const nebulaColors = [0x06b6d4, 0x7c3aed, 0xec4899, 0x1d4ed8];
    for (let i = 0; i < nebulaCount; i++) {
      const geo = new THREE.SphereGeometry(
        Math.random() * 80 + 50,
        16,
        16
      );
      const mat = new THREE.MeshBasicMaterial({
        color: nebulaColors[i % nebulaColors.length],
        transparent: true,
        opacity: mode === "subtle" ? 0.03 : 0.06,
        blending: THREE.AdditiveBlending,
        wireframe: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        (Math.random() - 0.5) * 1200,
        (Math.random() - 0.5) * 800,
        (Math.random() - 0.5) * 800 - 200
      );
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      nebulaGroup.add(mesh);
    }
    scene.add(nebulaGroup);

    // --- 3D Cloud Services Themed Elements (When in 'hero' or 'full' mode) ---
    const cloudClusterGroup = new THREE.Group();
    const serverRacks: THREE.Mesh[] = [];
    const satellites: { mesh: THREE.Group; orbitRadius: number; speed: number; angle: number; tilt: number }[] = [];
    const databasePods: THREE.Group[] = [];

    if (mode === "hero" || mode === "full") {
      // 1. Central Hyper-Plane Core Node (Metallic Server Rack Cluster)
      const coreGeo = new THREE.BoxGeometry(45, 75, 45);
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x09090b,
        metalness: 0.85,
        roughness: 0.2,
      });
      const coreRack = new THREE.Mesh(coreGeo, coreMat);
      coreRack.position.set(0, 0, 0);

      // Server rack wireframe edges for cyber aesthetic
      const edges = new THREE.EdgesGeometry(coreGeo);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x06b6d4,
        linewidth: 2,
        transparent: true,
        opacity: 0.85,
      });
      const wireframe = new THREE.LineSegments(edges, lineMat);
      coreRack.add(wireframe);

      // Server LED lights
      for (let j = 0; j < 8; j++) {
        const ledGeo = new THREE.BoxGeometry(35, 2, 2);
        const ledMat = new THREE.MeshBasicMaterial({
          color: j % 2 === 0 ? 0x22c55e : 0x06b6d4,
        });
        const led = new THREE.Mesh(ledGeo, ledMat);
        led.position.set(0, -28 + j * 8, 23);
        coreRack.add(led);
      }
      cloudClusterGroup.add(coreRack);
      serverRacks.push(coreRack);

      // 2. Glowing Database Cylinder Pods (PostgreSQL & Redis)
      const dbNames = ["PostgreSQL", "Redis"];
      const dbColors = [0x336791, 0xdc2626];

      for (let d = 0; d < 2; d++) {
        const dbGroup = new THREE.Group();
        const cylGeo = new THREE.CylinderGeometry(14, 14, 30, 24);
        const cylMat = new THREE.MeshStandardMaterial({
          color: 0x18181b,
          metalness: 0.9,
          roughness: 0.3,
        });
        const cyl = new THREE.Mesh(cylGeo, cylMat);

        const ringGeo = new THREE.TorusGeometry(18, 1.2, 12, 48);
        const ringMat = new THREE.MeshBasicMaterial({
          color: dbColors[d],
          transparent: true,
          opacity: 0.9,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2;

        dbGroup.add(cyl);
        dbGroup.add(ring);
        dbGroup.position.set(d === 0 ? -120 : 120, d === 0 ? -40 : 40, -50);
        cloudClusterGroup.add(dbGroup);
        databasePods.push(dbGroup);
      }

      // 3. Orbiting Edge POP Satellites (iad1, sfo1, fra1, lhr1, sin1, syd1)
      const popColors = [0x06b6d4, 0x3b82f6, 0x8b5cf6, 0xec4899, 0x10b981, 0xf59e0b];
      const popLabels = ["iad1", "sfo1", "fra1", "lhr1", "sin1", "syd1"];

      for (let s = 0; s < 6; s++) {
        const satGroup = new THREE.Group();

        // Satellite core pod
        const podGeo = new THREE.DodecahedronGeometry(8, 0);
        const podMat = new THREE.MeshStandardMaterial({
          color: 0x27272a,
          metalness: 0.95,
          roughness: 0.15,
        });
        const podMesh = new THREE.Mesh(podGeo, podMat);
        satGroup.add(podMesh);

        // Glowing solar arrays
        const panelGeo = new THREE.BoxGeometry(20, 0.8, 6);
        const panelMat = new THREE.MeshBasicMaterial({
          color: popColors[s],
          transparent: true,
          opacity: 0.85,
        });
        const panelMesh = new THREE.Mesh(panelGeo, panelMat);
        satGroup.add(panelMesh);

        // Blinking beacon light
        const beaconGeo = new THREE.SphereGeometry(2, 12, 12);
        const beaconMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
        });
        const beacon = new THREE.Mesh(beaconGeo, beaconMat);
        beacon.position.y = 9;
        satGroup.add(beacon);

        // Orbit ring guide
        const orbitRadius = 160 + s * 30;
        const orbitRingGeo = new THREE.RingGeometry(orbitRadius - 0.5, orbitRadius + 0.5, 64);
        const orbitRingMat = new THREE.MeshBasicMaterial({
          color: popColors[s],
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.12,
        });
        const orbitRing = new THREE.Mesh(orbitRingGeo, orbitRingMat);
        orbitRing.rotation.x = Math.PI / 2 + (s * 0.1);
        cloudClusterGroup.add(orbitRing);

        satellites.push({
          mesh: satGroup,
          orbitRadius,
          speed: 0.008 + (s * 0.002),
          angle: (s * Math.PI) / 3,
          tilt: s * 0.15,
        });

        cloudClusterGroup.add(satGroup);
      }

      // Lights for realistic 4K 3D shading
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
      scene.add(ambientLight);

      const dirLight1 = new THREE.DirectionalLight(0x06b6d4, 2.5);
      dirLight1.position.set(200, 300, 400);
      scene.add(dirLight1);

      const dirLight2 = new THREE.DirectionalLight(0x8b5cf6, 2.0);
      dirLight2.position.set(-200, -200, -300);
      scene.add(dirLight2);

      scene.add(cloudClusterGroup);
    }

    // --- Interactive Mouse & Parallax Physics ---
    let mouseX = 0;
    let mouseY = 0;
    let targetCameraX = 0;
    let targetCameraY = 0;

    const handleMouseMove = (e: MouseEvent) => {
      mouseX = (e.clientX - window.innerWidth / 2) * 0.4;
      mouseY = (e.clientY - window.innerHeight / 2) * 0.4;
    };

    if (interactive) {
      window.addEventListener("mousemove", handleMouseMove);
    }

    // --- Animation Loop ---
    let animId: number;
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      const elapsedTime = clock.getElapsedTime();

      // 1. Warp Starfield movement
      const pos = starGeometry.attributes.position.array as Float32Array;
      for (let i = 0; i < starCount; i++) {
        const zIdx = i * 3 + 2;
        pos[zIdx] += starVelocities[i] * 1.5;

        // Reset stars that fly past camera
        if (pos[zIdx] > 1000) {
          pos[zIdx] = -1200;
          pos[i * 3] = (Math.random() - 0.5) * 2000;
          pos[i * 3 + 1] = (Math.random() - 0.5) * 2000;
        }
      }
      starGeometry.attributes.position.needsUpdate = true;

      // 2. Slow cosmic nebula rotation
      nebulaGroup.rotation.y = elapsedTime * 0.02;
      nebulaGroup.rotation.x = Math.sin(elapsedTime * 0.015) * 0.1;

      // 3. Cloud Services Models Animations
      if (mode === "hero" || mode === "full") {
        // Rotate central server cluster
        serverRacks.forEach((rack) => {
          rack.rotation.y = elapsedTime * 0.35;
          rack.position.y = Math.sin(elapsedTime * 0.8) * 8;
        });

        // Rotate database pods
        databasePods.forEach((pod, idx) => {
          pod.rotation.y = -elapsedTime * 0.5;
          pod.position.y += Math.sin(elapsedTime * 1.2 + idx) * 0.15;
        });

        // Orbit satellites
        satellites.forEach((sat) => {
          sat.angle += sat.speed;
          sat.mesh.position.x = Math.cos(sat.angle) * sat.orbitRadius;
          sat.mesh.position.z = Math.sin(sat.angle) * sat.orbitRadius;
          sat.mesh.position.y = Math.sin(sat.angle * 2) * 25 + Math.sin(sat.tilt) * 20;

          sat.mesh.rotation.y += 0.02;
          sat.mesh.rotation.z += 0.01;
        });

        cloudClusterGroup.rotation.y = Math.sin(elapsedTime * 0.1) * 0.15;
      }

      // Smooth camera interpolation for fluid feel
      targetCameraX += (mouseX - targetCameraX) * 0.03;
      targetCameraY += (-mouseY - targetCameraY) * 0.03;

      camera.position.x = targetCameraX;
      camera.position.y = targetCameraY;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };

    animate();

    // --- Window Resize Handling ---
    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", handleResize);

    // --- Cleanup ---
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      if (interactive) window.removeEventListener("mousemove", handleMouseMove);

      renderer.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
      starTexture.dispose();

      if (container && renderer.domElement) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [mode, interactive]);

  return (
    <div
      ref={mountRef}
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      style={{
        opacity: mode === "subtle" ? 0.75 : 0.95,
        transition: "opacity 0.6s ease-in-out",
      }}
      aria-hidden="true"
    />
  );
}
