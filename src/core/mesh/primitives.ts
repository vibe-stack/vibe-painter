/**
 * Built-in meshes.
 *
 * Every primitive here has a *non-overlapping* UV layout. That matters more
 * than it sounds: three's own BoxGeometry gives all six faces the full 0..1
 * square, so painting one face would paint all six. Cube and cylinder are
 * therefore rebuilt with a proper atlas.
 */

import {
  BufferAttribute,
  BufferGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  Vector3,
} from 'three/webgpu'
import { prepareGeometry } from './tangents'

export interface PrimitiveDef {
  id: string
  name: string
  description: string
  build(): BufferGeometry
}

/** Gap left between UV islands so dilation has somewhere to bleed into. */
const ATLAS_MARGIN = 0.01

function atlasBox(size = 1, segments = 24): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const half = size / 2

  // Six faces packed into a 3x2 grid, each face getting its own UV island.
  const faces: { normal: Vector3; u: Vector3; v: Vector3; col: number; row: number }[] = [
    { normal: new Vector3(1, 0, 0), u: new Vector3(0, 0, -1), v: new Vector3(0, 1, 0), col: 0, row: 0 },
    { normal: new Vector3(-1, 0, 0), u: new Vector3(0, 0, 1), v: new Vector3(0, 1, 0), col: 1, row: 0 },
    { normal: new Vector3(0, 1, 0), u: new Vector3(1, 0, 0), v: new Vector3(0, 0, -1), col: 2, row: 0 },
    { normal: new Vector3(0, -1, 0), u: new Vector3(1, 0, 0), v: new Vector3(0, 0, 1), col: 0, row: 1 },
    { normal: new Vector3(0, 0, 1), u: new Vector3(1, 0, 0), v: new Vector3(0, 1, 0), col: 1, row: 1 },
    { normal: new Vector3(0, 0, -1), u: new Vector3(-1, 0, 0), v: new Vector3(0, 1, 0), col: 2, row: 1 },
  ]

  const cellW = 1 / 3
  const cellH = 1 / 2
  const p = new Vector3()

  for (const face of faces) {
    const base = positions.length / 3
    for (let iy = 0; iy <= segments; iy++) {
      for (let ix = 0; ix <= segments; ix++) {
        const fx = ix / segments
        const fy = iy / segments
        p.copy(face.normal).multiplyScalar(half)
          .addScaledVector(face.u, (fx * 2 - 1) * half)
          .addScaledVector(face.v, (fy * 2 - 1) * half)
        positions.push(p.x, p.y, p.z)
        normals.push(face.normal.x, face.normal.y, face.normal.z)
        uvs.push(
          (face.col + ATLAS_MARGIN + fx * (1 - ATLAS_MARGIN * 2)) * cellW,
          (face.row + ATLAS_MARGIN + fy * (1 - ATLAS_MARGIN * 2)) * cellH,
        )
      }
    }
    for (let iy = 0; iy < segments; iy++) {
      for (let ix = 0; ix < segments; ix++) {
        const a = base + iy * (segments + 1) + ix
        const b = a + 1
        const c = a + segments + 1
        const d = c + 1
        indices.push(a, c, b, b, c, d)
      }
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(indices)
  return geometry
}

function atlasCylinder(radius = 0.6, height = 1.6, radial = 64, heightSegments = 24): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const half = height / 2

  // Side wall fills the top half of the UV square...
  const sideBase = 0
  for (let iy = 0; iy <= heightSegments; iy++) {
    const v = iy / heightSegments
    for (let ix = 0; ix <= radial; ix++) {
      const u = ix / radial
      const theta = u * Math.PI * 2
      const sx = Math.sin(theta)
      const cz = Math.cos(theta)
      positions.push(sx * radius, -half + v * height, cz * radius)
      normals.push(sx, 0, cz)
      uvs.push(ATLAS_MARGIN + u * (1 - ATLAS_MARGIN * 2), 0.5 + ATLAS_MARGIN + v * (0.5 - ATLAS_MARGIN * 2))
    }
  }
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < radial; ix++) {
      const a = sideBase + iy * (radial + 1) + ix
      const b = a + 1
      const c = a + radial + 1
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }

  // ...and the two caps sit as discs in the bottom half, side by side.
  const cap = (sign: 1 | -1, centreU: number) => {
    const base = positions.length / 3
    const centreV = 0.25
    const discR = 0.22
    positions.push(0, sign * half, 0)
    normals.push(0, sign, 0)
    uvs.push(centreU, centreV)
    for (let ix = 0; ix <= radial; ix++) {
      const theta = (ix / radial) * Math.PI * 2
      const sx = Math.sin(theta)
      const cz = Math.cos(theta)
      positions.push(sx * radius, sign * half, cz * radius)
      normals.push(0, sign, 0)
      uvs.push(centreU + sx * discR * sign, centreV + cz * discR)
    }
    for (let ix = 0; ix < radial; ix++) {
      const a = base
      const b = base + 1 + ix
      const c = base + 2 + ix
      if (sign > 0) indices.push(a, c, b)
      else indices.push(a, b, c)
    }
  }
  cap(1, 0.25)
  cap(-1, 0.75)

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(indices)
  return geometry
}

export const PRIMITIVES: PrimitiveDef[] = [
  {
    id: 'sphere',
    name: 'Sphere',
    description: 'Latitude/longitude sphere. One seam, heavy UV distortion at the poles - a good stress test for projection modes.',
    build: () => new SphereGeometry(1, 96, 64),
  },
  {
    id: 'cube',
    name: 'Cube',
    description: 'Six flat faces in a 3x2 UV atlas, so each face owns its own texels.',
    build: () => atlasBox(1.6, 24),
  },
  {
    id: 'torus-knot',
    name: 'Torus Knot',
    description: 'Continuous UVs with strong curvature variation. The default, because curvature-driven masks show up clearly on it.',
    build: () => new TorusKnotGeometry(0.8, 0.28, 256, 48),
  },
  {
    id: 'torus',
    name: 'Torus',
    description: 'Clean periodic UVs with a genuine concave region on the inner ring - useful for testing AO-driven dirt.',
    build: () => new TorusGeometry(0.9, 0.36, 128, 64),
  },
  {
    id: 'cylinder',
    name: 'Cylinder',
    description: 'Side wall plus packed cap discs, all in one non-overlapping atlas.',
    build: () => atlasCylinder(),
  },
  {
    id: 'plane',
    name: 'Plane',
    description: 'A flat quad with 1:1 UVs. The clearest way to inspect a material on its own.',
    build: () => {
      const g = new PlaneGeometry(2, 2, 64, 64)
      return g
    },
  },
]

export function getPrimitive(id: string): PrimitiveDef | null {
  return PRIMITIVES.find((p) => p.id === id) ?? null
}

export function buildPrimitive(id: string): BufferGeometry {
  const def = getPrimitive(id)
  if (!def) throw new Error(`Unknown primitive "${id}"`)
  return prepareGeometry(def.build())
}
