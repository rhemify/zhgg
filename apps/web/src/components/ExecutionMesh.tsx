import { useEffect, useRef } from "react"
import * as THREE from "three"

// ── Scene configuration ───────────────────────────────────────────────────────

const AGENT_NODES = [
  { label: "swap-agent",    color: 0x00ff88, r: 4.2, tilt: 0.15,  phase: 0,              speed: 0.28, rail: "x402" },
  { label: "yield-agent",   color: 0xf59e0b, r: 5.1, tilt: 0.35,  phase: Math.PI * 0.66, speed: 0.20, rail: "mpp"  },
  { label: "monitor-agent", color: 0x818cf8, r: 3.8, tilt: -0.2,  phase: Math.PI * 1.33, speed: 0.32, rail: "x402" },
  { label: "risk-agent",    color: 0x00ff88, r: 4.7, tilt: 0.45,  phase: Math.PI,        speed: 0.24, rail: "gas"  },
  { label: "bridge-agent",  color: 0xf59e0b, r: 5.3, tilt: -0.4,  phase: Math.PI * 0.33, speed: 0.18, rail: "mpp"  },
  { label: "nft-agent",     color: 0x818cf8, r: 4.0, tilt: 0.25,  phase: Math.PI * 1.66, speed: 0.30, rail: "gas"  },
]

const PROTOCOL_NODES = [
  { label: "Uniswap",  color: 0xff007a, phase: 0                },
  { label: "Aave",     color: 0x2ebac6, phase: Math.PI * 0.5   },
  { label: "Lido",     color: 0x00a3ff, phase: Math.PI          },
  { label: "ENS",      color: 0x5298ff, phase: Math.PI * 1.5   },
]

const RAIL_COLORS: Record<string, number> = {
  x402: 0x00ff88,
  mpp:  0x818cf8,
  gas:  0xf59e0b,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function glowMat(color: number, opacity: number, additive = true): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
  })
}

function agentPosition(
  cfg: typeof AGENT_NODES[0],
  t: number
): THREE.Vector3 {
  const angle = t * cfg.speed + cfg.phase
  return new THREE.Vector3(
    Math.cos(angle) * cfg.r,
    Math.sin(angle * 0.7 + cfg.phase) * cfg.r * Math.sin(cfg.tilt),
    Math.sin(angle) * cfg.r,
  )
}

// Compute a curved path from agent → hub with one bent midpoint
function buildCurve(
  agentPos: THREE.Vector3,
  midBend: number
): THREE.CatmullRomCurve3 {
  const mid = agentPos.clone().multiplyScalar(0.5)
  // Perpendicular offset for graceful curve
  const perp = new THREE.Vector3(-agentPos.z, agentPos.y * 0.5, agentPos.x)
    .normalize()
    .multiplyScalar(midBend)
  mid.add(perp)
  return new THREE.CatmullRomCurve3([agentPos.clone(), mid, new THREE.Vector3(0, 0, 0)])
}

// ── Main component ────────────────────────────────────────────────────────────

export function ExecutionMesh({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.sortObjects = true

    const scene  = new THREE.Scene()
    scene.fog    = new THREE.FogExp2(0x000000, 0.018)

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)
    camera.position.set(0, 4, 14)
    camera.lookAt(0, 0, 0)

    const resize = () => {
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    // ── Starfield ─────────────────────────────────────────────────────────────
    const starGeo = new THREE.BufferGeometry()
    const starPos = new Float32Array(2400)
    for (let i = 0; i < starPos.length; i++) {
      starPos[i] = (Math.random() - 0.5) * 140
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3))
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.04, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })))

    // ── Central hub (ExecutionContext) ────────────────────────────────────────
    const hubGroup = new THREE.Group()
    scene.add(hubGroup)

    // Core
    hubGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 32, 32),
      glowMat(0x00ff88, 0.9),
    ))
    // Inner glow layer
    hubGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.3, 24, 24),
      new THREE.MeshBasicMaterial({
        color: 0x00ff88, transparent: true, opacity: 0.12,
        side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    ))
    // Outer halo
    hubGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.9, 24, 24),
      new THREE.MeshBasicMaterial({
        color: 0x00ff88, transparent: true, opacity: 0.04,
        side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    ))

    // Rings (3, different inclinations)
    const RINGS = [
      { ri: 1.5, ro: 1.56, tiltX: Math.PI / 2, tiltY: 0,    opacity: 0.35 },
      { ri: 1.8, ro: 1.85, tiltX: 1.2,          tiltY: 0.8,  opacity: 0.22 },
      { ri: 2.1, ro: 2.14, tiltX: 0.5,          tiltY: 1.8,  opacity: 0.14 },
    ]
    const ringMeshes: THREE.Mesh[] = []
    RINGS.forEach(({ ri, ro, tiltX, tiltY, opacity }) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(ri, ro, 80),
        new THREE.MeshBasicMaterial({
          color: 0x00ff88, transparent: true, opacity,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      )
      m.rotation.x = tiltX
      m.rotation.y = tiltY
      hubGroup.add(m)
      ringMeshes.push(m)
    })

    // ── Agent nodes ───────────────────────────────────────────────────────────
    const agentMeshes: THREE.Mesh[]  = []
    const agentGlows:  THREE.Mesh[]  = []
    const agentCurves: THREE.CatmullRomCurve3[] = []

    AGENT_NODES.forEach((cfg, i) => {
      const pos = agentPosition(cfg, 0)

      // Core sphere
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 16, 16),
        glowMat(cfg.color, 0.95),
      )
      core.position.copy(pos)
      scene.add(core)
      agentMeshes.push(core)

      // Glow halo
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.46, 16, 16),
        glowMat(cfg.color, 0.06),
      )
      glow.position.copy(pos)
      scene.add(glow)
      agentGlows.push(glow)

      // Curve for tube + packet
      const bend = (i % 2 === 0 ? 1 : -1) * (1.2 + (i % 3) * 0.4)
      agentCurves.push(buildCurve(pos, bend))
    })

    // ── Connection tubes (one per agent, static TubeGeometry each frame rebuild
    //    is too expensive — use Line for the dynamic part, TubeGeometry for glow) ──
    // Strategy: use Line segments (cheap) + wider glow Lines for additive bloom.
    const tubeCores:  THREE.Line[] = []
    const tubeGlows:  THREE.Line[] = []

    AGENT_NODES.forEach((cfg, i) => {
      const railColor = RAIL_COLORS[cfg.rail] ?? 0x00ff88

      const coreMat = new THREE.LineBasicMaterial({
        color: railColor, transparent: true, opacity: 0.6,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
      const glowMat2 = new THREE.LineBasicMaterial({
        color: railColor, transparent: true, opacity: 0.12,
        blending: THREE.AdditiveBlending, depthWrite: false, linewidth: 1,
      })

      const pts   = agentCurves[i]!.getPoints(48)
      const coreG = new THREE.BufferGeometry().setFromPoints(pts)
      const glowG = new THREE.BufferGeometry().setFromPoints(pts)

      const tCore = new THREE.Line(coreG, coreMat)
      const tGlow = new THREE.Line(glowG, glowMat2)
      scene.add(tCore)
      scene.add(tGlow)
      tubeCores.push(tCore)
      tubeGlows.push(tGlow)
    })

    // ── Protocol nodes (outer ring, fixed) ────────────────────────────────────
    const protocolR = 7.5
    PROTOCOL_NODES.forEach((p) => {
      const pos = new THREE.Vector3(
        Math.cos(p.phase) * protocolR,
        (Math.random() - 0.5) * 1.5,
        Math.sin(p.phase) * protocolR,
      )
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 12),
        glowMat(p.color, 0.8),
      )
      m.position.copy(pos)
      scene.add(m)

      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.38, 12, 12),
        glowMat(p.color, 0.05),
      )
      halo.position.copy(pos)
      scene.add(halo)

      // Thin line from hub to protocol
      const lineMat = new THREE.LineBasicMaterial({
        color: p.color, transparent: true, opacity: 0.1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), pos,
      ])
      scene.add(new THREE.Line(lineGeo, lineMat))
    })

    // ── Data packets ──────────────────────────────────────────────────────────
    const packets: Array<{ mesh: THREE.Mesh; glow: THREE.Mesh; t: number; speed: number; curveIdx: number }> = []

    AGENT_NODES.forEach((cfg, i) => {
      const railColor = RAIL_COLORS[cfg.rail] ?? 0x00ff88
      const offset    = (i / AGENT_NODES.length)

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 8, 8),
        glowMat(0xffffff, 0.95),
      )
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 8, 8),
        glowMat(railColor, 0.25),
      )
      scene.add(core)
      scene.add(glow)
      packets.push({ mesh: core, glow, t: offset, speed: 0.18 + (i % 3) * 0.05, curveIdx: i })
    })

    // ── Animation loop ────────────────────────────────────────────────────────
    let animId = 0
    let time   = 0

    const animate = (now: number) => {
      animId = requestAnimationFrame(animate)
      const dt = Math.min((now - (animate as any)._prev || 16) / 1000, 0.05)
      ;(animate as any)._prev = now
      time += dt

      // Hub breathe
      const pulse = 1 + Math.sin(time * 1.8) * 0.04
      hubGroup.scale.setScalar(pulse)

      // Ring rotation
      ringMeshes[0]!.rotation.z += dt * 0.25
      ringMeshes[1]!.rotation.z -= dt * 0.18
      ringMeshes[2]!.rotation.y += dt * 0.12

      // Update agent positions + tubes + packets
      AGENT_NODES.forEach((cfg, i) => {
        const pos = agentPosition(cfg, time)

        agentMeshes[i]!.position.copy(pos)
        agentGlows[i]!.position.copy(pos)

        // Rebuild curve from updated agent position
        const bend = (i % 2 === 0 ? 1 : -1) * (1.2 + (i % 3) * 0.4)
        const curve = buildCurve(pos, bend)
        agentCurves[i] = curve

        const pts = curve.getPoints(48)

        // Update tube geometry
        ;(tubeCores[i]!.geometry as THREE.BufferGeometry).setFromPoints(pts)
        ;(tubeGlows[i]!.geometry as THREE.BufferGeometry).setFromPoints(pts)
      })

      // Move packets along curves
      packets.forEach((p) => {
        p.t = (p.t + p.speed * dt) % 1.0
        const curve = agentCurves[p.curveIdx]!
        // t=0 is agent side, t=1 is hub side
        const pt = curve.getPointAt(Math.min(p.t, 0.999))
        p.mesh.position.copy(pt)
        p.glow.position.copy(pt)
        // Fade out near hub
        const opacity = p.t > 0.75 ? (1 - p.t) * 4 : 1
        ;(p.mesh.material as THREE.MeshBasicMaterial).opacity = opacity * 0.95
        ;(p.glow.material as THREE.MeshBasicMaterial).opacity = opacity * 0.25
      })

      // Camera slow orbit + gentle bob
      const camAngle = time * 0.07
      const camR     = 14
      camera.position.set(
        Math.sin(camAngle) * camR,
        3.5 + Math.sin(time * 0.15) * 0.8,
        Math.cos(camAngle) * camR,
      )
      camera.lookAt(0, 0, 0)

      renderer.render(scene, camera)
    }

    requestAnimationFrame(animate)

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animId)
      ro.disconnect()
      renderer.dispose()
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose()
        if ((obj as THREE.Mesh).material) {
          const mat = (obj as THREE.Mesh).material
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
          else mat.dispose()
        }
      })
    }
  }, [])

  return <canvas ref={canvasRef} className={className} style={{ display: "block" }} />
}
