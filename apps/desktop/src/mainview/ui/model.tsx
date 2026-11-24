// A 3D file in a chat, to turn: STL, 3MF, GLB, glTF or OBJ, drawn with three.js. Dragging turns
// it, a pinch zooms, and scrolling scrolls the chat past it. It's fetched as the core's light copy
// (blobs.ts), so a 100 MB scan arrives as a few MB. One model at a time is live, the one the pointer
// is over; the rest are pictures of it (a 3MF's own thumbnail when it has one). All of them are drawn
// with the app's one WebGL context (gl, below). Printing files are Z-up.
import { queryOptions, useQuery } from "@tanstack/react-query"
import { strFromU8, unzipSync } from "fflate"
import { useState } from "react"
import * as THREE from "three"
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"

import { Spin, Stop } from "./marks.tsx"

const extension = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase()

const shaded = () =>
  new THREE.MeshStandardMaterial({ color: 0xa8_ad_b4, roughness: 0.55, metalness: 0.05 })

/** The model as a scene object, upright. */
const parse = async (data: ArrayBuffer, name: string): Promise<THREE.Object3D> => {
  const ext = extension(name)
  if (ext === "glb" || ext === "gltf") {
    const gltf = await new GLTFLoader().parseAsync(data, "")
    return gltf.scene
  }
  if (ext === "obj") {
    const obj = new OBJLoader().parse(new TextDecoder().decode(data))
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.material = shaded()
      }
    })
    return obj
  }
  const zUp =
    ext === "3mf"
      ? new ThreeMFLoader().parse(data)
      : new THREE.Mesh(new STLLoader().parse(data), shaded())
  if (ext === "3mf") {
    zUp.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshPhongMaterial) {
        o.material = new THREE.MeshStandardMaterial({
          color: o.material.color,
          roughness: 0.55,
          metalness: 0.05,
        })
      }
    })
  }
  const upright = new THREE.Group()
  zUp.rotation.x = -Math.PI / 2
  upright.add(zUp)
  return upright
}

/** The picture a zip package (3MF) names as its thumbnail, as an address; null when none. */
const thumbnailIn = (data: ArrayBuffer) => {
  const bytes = new Uint8Array(data)
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return null
  }
  const files = unzipSync(bytes, {
    filter: (f) =>
      f.name.endsWith(".rels") ||
      f.name.endsWith(".png") ||
      f.name.endsWith(".jpg") ||
      f.name.endsWith(".jpeg"),
  })
  const rels = files["_rels/.rels"]
  const target = [
    ...strFromU8(rels ?? new Uint8Array()).matchAll(/<Relationship\b(?<tag>[^>]*)\/>/gu),
  ]
    .map((m) => m.groups?.tag ?? "")
    .find((r) => /Type="[^"]*\/metadata\/thumbnail"/u.test(r))
    ?.match(/Target="(?<target>[^"]*)"/u)?.groups?.target
  if (target === undefined) {
    return null
  }
  const picture = files[target.replace(/^\//u, "")]
  if (picture === undefined) {
    return null
  }
  const type = target.endsWith(".png") ? "image/png" : "image/jpeg"
  return URL.createObjectURL(new Blob([picture], { type }))
}

/** Where a blob's light copy is (a model on the core); anything else, where it is. */
const lightOf = (url: string) => {
  const at = new URL(url, location.href)
  if (/^\/blobs\/[0-9a-f]{64}$/u.test(at.pathname)) {
    at.pathname = `${at.pathname}/light`
  }
  return at.toString()
}

interface Loaded {
  readonly model: THREE.Object3D
  /** A picture of it at rest. */
  readonly picture: string
  /** Its middle and size, and the camera's place, framing it whole. */
  readonly radius: number
}

const SIZE = { width: 840, height: 640 }
const FOV = 35

const lights = (scene: THREE.Scene) => {
  scene.add(new THREE.HemisphereLight(0xff_ff_ff, 0x40_40_48, 2.2))
  const sun = new THREE.DirectionalLight(0xff_ff_ff, 1.6)
  scene.add(sun)
  return sun
}

/** Centred on the origin; its size, as a radius. */
const centred = (model: THREE.Object3D) => {
  const box = new THREE.Box3().setFromObject(model)
  model.position.sub(box.getCenter(new THREE.Vector3()))
  return Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3)
}

/** Where the camera starts: framing it whole, from above and to the side. */
const home = (radius: number) => {
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2))
  return new THREE.Vector3(distance * 0.6, distance * 0.45, distance * 0.7)
}

/**
 * The one WebGL context the app holds: every picture and the live model are drawn with it off screen
 * and copied to where they show. Made and dropped per model, as they were, a context WebKit gave
 * could come back already lost, and the page went down with it.
 */
let shared: THREE.WebGLRenderer | null = null

const gl = () => {
  shared ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  return shared
}

/** Its buffers off the GPU until it's drawn again, which puts them back. */
const release = (model: THREE.Object3D) => {
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) {
      return
    }
    if (o.geometry instanceof THREE.BufferGeometry) {
      o.geometry.dispose()
    }
    for (const m of [o.material].flat()) {
      if (m instanceof THREE.Material) {
        m.dispose()
      }
    }
  })
}

/** The model drawn once at rest, as an address. */
const drawn = (renderer: THREE.WebGLRenderer, model: THREE.Object3D, radius: number) => {
  renderer.setPixelRatio(1)
  renderer.setSize(SIZE.width, SIZE.height, false)
  const scene = new THREE.Scene()
  const sun = lights(scene)
  scene.add(model)
  const camera = new THREE.PerspectiveCamera(
    FOV,
    SIZE.width / SIZE.height,
    radius / 100,
    radius * 100,
  )
  camera.position.copy(home(radius))
  camera.lookAt(0, 0, 0)
  sun.position.copy(camera.position)
  renderer.render(scene, camera)
  const url = renderer.domElement.toDataURL("image/png")
  scene.remove(model)
  release(model)
  return url
}

/** A 3D file, loaded to be drawn, by where it's fetched and its name. */
const modelQuery = (url: string, name: string) =>
  queryOptions({
    queryKey: ["model", url],
    queryFn: async (): Promise<Loaded> => {
      // Made with the first model, so a context WebKit refuses is that model's error, never the
      // page's: the live model draws with the same one.
      const renderer = gl()
      const res = await fetch(lightOf(url))
      if (!res.ok) {
        throw new Error(res.status === 404 ? "Gone" : "Can't load")
      }
      const data = await res.arrayBuffer()
      const model = await parse(data, name)
      const radius = centred(model)
      return { model, radius, picture: thumbnailIn(data) ?? drawn(renderer, model, radius) }
    },
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: 1,
  })

/** Where each model's camera was left, so it's as it was when it's live again. */
const views = new WeakMap<THREE.Object3D, THREE.Vector3>()

/** Draws the model in the canvas, turned by dragging and zoomed by a pinch, until it unmounts. */
const draw = (loaded: Loaded) => (canvas: HTMLCanvasElement) => {
  const { model, radius } = loaded
  const renderer = gl()
  const shown = canvas.getContext("2d")
  const scene = new THREE.Scene()
  const sun = lights(scene)
  scene.add(model)

  const camera = new THREE.PerspectiveCamera(FOV, 1, radius / 100, radius * 100)
  camera.position.copy(views.get(model) ?? home(radius))
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  // A scroll scrolls the chat and a right-click is the file's menu: only a pinch zooms (below).
  controls.enableZoom = false
  controls.enablePan = false

  let frame = 0
  const render = () => {
    frame = 0
    const moving = controls.update()
    sun.position.copy(camera.position)
    renderer.setPixelRatio(1)
    renderer.setSize(canvas.width, canvas.height, false)
    renderer.render(scene, camera)
    shown?.clearRect(0, 0, canvas.width, canvas.height)
    shown?.drawImage(renderer.domElement, 0, 0)
    if (moving) {
      frame = requestAnimationFrame(render)
    }
  }
  const soon = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(render)
    }
  }
  controls.addEventListener("change", soon)

  const zoom = (by: number) => {
    const distance = THREE.MathUtils.clamp(camera.position.length() * by, radius * 0.3, radius * 30)
    camera.position.setLength(distance)
    soon()
  }
  // A trackpad's pinch: WebKit's gesture events, or a wheel with Control held, as Chromium sends it.
  let scale = 1
  const gestureStart = (e: Event) => {
    e.preventDefault()
    scale = 1
  }
  const gestureChange = (e: Event) => {
    e.preventDefault()
    const now = "scale" in e && typeof e.scale === "number" ? e.scale : 1
    zoom(scale / Math.max(now, 1e-3))
    scale = now
  }
  const wheel = (e: WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault()
      zoom(Math.exp(e.deltaY * 0.01))
    }
  }
  canvas.addEventListener("gesturestart", gestureStart)
  canvas.addEventListener("gesturechange", gestureChange)
  canvas.addEventListener("wheel", wheel, { passive: false })

  const resize = new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = canvas
    canvas.width = Math.round(w * window.devicePixelRatio)
    canvas.height = Math.round(h * window.devicePixelRatio)
    camera.aspect = w / Math.max(h, 1)
    camera.updateProjectionMatrix()
    soon()
  })
  resize.observe(canvas)

  return () => {
    views.set(model, camera.position.clone())
    cancelAnimationFrame(frame)
    resize.disconnect()
    canvas.removeEventListener("gesturestart", gestureStart)
    canvas.removeEventListener("gesturechange", gestureChange)
    canvas.removeEventListener("wheel", wheel)
    controls.dispose()
    scene.remove(model)
    release(model)
  }
}

/** The one model that's live: told to rest when another is. */
let resting: (() => void) | null = null

const Model = ({ url, name, className }: { url: string; name: string; className: string }) => {
  const loaded = useQuery(modelQuery(url, name))
  const [live, setLive] = useState(false)
  if (loaded.isError) {
    return (
      <span className={`flex items-center justify-center gap-2 text-small text-ink2 ${className}`}>
        <Stop size={12} />
        {loaded.error.message}
      </span>
    )
  }
  if (loaded.data === undefined) {
    return (
      <span className={`flex items-center justify-center ${className}`}>
        <Spin />
      </span>
    )
  }
  const wake = () => {
    if (live) {
      return
    }
    resting?.()
    resting = () => {
      setLive(false)
    }
    setLive(true)
  }
  if (!live) {
    return (
      <img
        src={loaded.data.picture}
        alt={name}
        decoding="sync"
        onPointerEnter={wake}
        onPointerDown={wake}
        className={`block cursor-grab object-contain ${className}`}
      />
    )
  }
  return (
    <canvas
      ref={draw(loaded.data)}
      aria-label={name}
      className={`block cursor-grab touch-none active:cursor-grabbing ${className}`}
    />
  )
}

export default Model
