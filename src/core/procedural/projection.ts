/**
 * Projection: how a 2D procedural material lands on a 3D surface.
 *
 * Materials are authored against a flat coordinate. This module supplies that
 * coordinate - from mesh UVs, from a world-space plane, or from all three
 * planes at once - and puts the resulting normals back into the mesh's tangent
 * space so the compositor only ever deals with one normal convention.
 *
 * Tiling, offset, rotation and triplanar sharpness arrive as *nodes*, not
 * numbers. That is what lets the inspector's sliders update a uniform buffer
 * instead of recompiling the whole stack's shader on every mouse move.
 */

import { abs, cos, float, max, normalize, sin, vec2, vec3 } from 'three/tsl'
import type { Projection } from '../doc/types'
import type { ChannelBundle, F, V2, V3 } from '../gpu/nodes'
import { completeBundle } from '../gpu/nodes'
import type { MatContext, MeshMapNodes, ProceduralMaterialDef } from './material'
import type { ParamBag } from './params'

/** Live projection controls, bound to uniforms. */
export interface ProjectionNodes {
  scale: V2
  offset: V2
  rotation: F
  sharpness: F
}

function rotate2D(p: V2, radians: F): V2 {
  const c = cos(radians)
  const s = sin(radians)
  return vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)))
}

function transform2D(uvNode: V2, nodes: ProjectionNodes): V2 {
  // Rotate about the centre so scaling and rotation feel independent.
  const centred = uvNode.sub(vec2(0.5, 0.5))
  return rotate2D(centred, nodes.rotation).mul(nodes.scale).add(vec2(0.5, 0.5)).add(nodes.offset)
}

/**
 * Puts a world-space normal into the mesh tangent frame. The compositor always
 * stores tangent-space normals, so every projection funnels through here.
 */
function worldToTangent(worldNormal: V3, maps: MeshMapNodes): V3 {
  return normalize(
    vec3(worldNormal.dot(maps.tangent), worldNormal.dot(maps.bitangent), worldNormal.dot(maps.normal)),
  )
}

export interface BuildArgs {
  def: ProceduralMaterialDef
  params: ParamBag
  mode: Projection
  /** Projection axis for planar / cylindrical. Structural, so it stays a number. */
  axis: 0 | 1 | 2
  nodes: ProjectionNodes
  maps: MeshMapNodes
  uv: V2
  texel: F
}

/** Evaluates a material under its projection and returns a complete bundle. */
export function buildProjected(args: BuildArgs): ChannelBundle {
  switch (args.mode) {
    case 'uv':
      return buildUV(args)
    case 'triplanar':
      return buildTriplanar(args)
    case 'planar':
      return buildPlanar(args)
    case 'spherical':
      return buildSpherical(args)
    case 'cylindrical':
      return buildCylindrical(args)
  }
}

function contextFor(args: BuildArgs, coord: V2, axis: number): MatContext {
  return { uv: coord, texel: args.texel, params: args.params, meshMaps: args.maps, axis }
}

function buildUV(args: BuildArgs): ChannelBundle {
  // UV projection needs no reorientation: the material's tangent space *is*
  // the mesh's tangent space.
  return completeBundle(args.def.build(contextFor(args, transform2D(args.uv, args.nodes), -1)))
}

function buildPlanar(args: BuildArgs): ChannelBundle {
  const coord = transform2D(planeCoord(args.maps.worldPosition, args.axis), args.nodes)
  const bundle = completeBundle(args.def.build(contextFor(args, coord, args.axis)))
  bundle.normal = worldToTangent(planeNormalToWorld(bundle.normal, args.axis, args.nodes.rotation), args.maps)
  return bundle
}

function buildSpherical(args: BuildArgs): ChannelBundle {
  const p = normalize(args.maps.position.sub(vec3(0.5, 0.5, 0.5)))
  const u = p.z.atan(p.x).div(Math.PI * 2).add(0.5)
  const v = p.y.clamp(-1, 1).asin().div(Math.PI).add(0.5)
  return completeBundle(args.def.build(contextFor(args, transform2D(vec2(u, v), args.nodes), -1)))
}

function buildCylindrical(args: BuildArgs): ChannelBundle {
  const p = args.maps.worldPosition
  const axis = args.axis
  const around = axis === 1 ? vec2(p.x, p.z) : axis === 0 ? vec2(p.y, p.z) : vec2(p.x, p.y)
  const along = axis === 1 ? p.y : axis === 0 ? p.x : p.z
  const u = around.y.atan(around.x).div(Math.PI * 2).add(0.5)
  return completeBundle(args.def.build(contextFor(args, transform2D(vec2(u, along), args.nodes), axis)))
}

/** The 2D slice of a world position for a given projection axis. */
function planeCoord(p: V3, axis: number): V2 {
  if (axis === 0) return vec2(p.z, p.y)
  if (axis === 1) return vec2(p.x, p.z)
  return vec2(p.x, p.y)
}

/** Undoes `planeCoord` for a tangent-space normal, producing a world normal. */
function planeNormalToWorld(n: V3, axis: number, rotation: F): V3 {
  // The material rotated its coordinate frame, so the normal rotates back.
  const t = vec3(rotate2D(vec2(n.x, n.y), rotation.negate()), n.z)
  if (axis === 0) return vec3(t.z, t.y, t.x)
  if (axis === 1) return vec3(t.x, t.z, t.y)
  return t
}

/**
 * Triplanar: evaluate the material once per axis and blend by how much the
 * surface faces that axis. Costs 3x the instructions, which is inherent - it is
 * also the only projection that ignores the UV layout entirely, so it never
 * shows seams or stretching.
 */
function buildTriplanar(args: BuildArgs): ChannelBundle {
  const p = args.maps.worldPosition
  const n = args.maps.normal

  const sharp = max(args.nodes.sharpness, float(1))
  const raw = abs(n).pow(vec3(sharp, sharp, sharp))
  const weights = raw.div(max(raw.x.add(raw.y).add(raw.z), float(1e-4)))

  const bundles = ([0, 1, 2] as const).map((axis) =>
    completeBundle(args.def.build(contextFor(args, transform2D(planeCoord(p, axis), args.nodes), axis))),
  )

  const wx = weights.x
  const wy = weights.y
  const wz = weights.z
  const mixScalar = (pick: (b: ChannelBundle) => F): F =>
    pick(bundles[0]).mul(wx).add(pick(bundles[1]).mul(wy)).add(pick(bundles[2]).mul(wz))
  const mixVector = (pick: (b: ChannelBundle) => V3): V3 =>
    pick(bundles[0]).mul(wx).add(pick(bundles[1]).mul(wy)).add(pick(bundles[2]).mul(wz))

  return {
    baseColor: mixVector((b) => b.baseColor),
    opacity: mixScalar((b) => b.opacity),
    roughness: mixScalar((b) => b.roughness),
    metallic: mixScalar((b) => b.metallic),
    height: mixScalar((b) => b.height),
    ao: mixScalar((b) => b.ao),
    emissive: mixVector((b) => b.emissive),
    normal: triplanarNormal(bundles.map((b) => b.normal), n, weights, args),
  }
}

/**
 * Whiteout blend for triplanar normals. Perturbing the geometric normal per
 * plane and re-swizzling keeps detail strong where the planes cross over; a
 * plain weighted average of tangent normals flattens it out instead.
 */
function triplanarNormal(normals: V3[], geoNormal: V3, weights: V3, args: BuildArgs): V3 {
  const rot = args.nodes.rotation.negate()
  const [nx, ny, nz] = normals.map((v) => vec3(rotate2D(vec2(v.x, v.y), rot), v.z))

  const tx = vec3(nx.x.add(geoNormal.z), nx.y.add(geoNormal.y), abs(nx.z).mul(geoNormal.x))
  const ty = vec3(ny.x.add(geoNormal.x), ny.y.add(geoNormal.z), abs(ny.z).mul(geoNormal.y))
  const tz = vec3(nz.x.add(geoNormal.x), nz.y.add(geoNormal.y), abs(nz.z).mul(geoNormal.z))

  const world = normalize(
    vec3(tx.z, tx.y, tx.x)
      .mul(weights.x)
      .add(vec3(ty.x, ty.z, ty.y).mul(weights.y))
      .add(tz.mul(weights.z)),
  )
  return worldToTangent(world, args.maps)
}

export { transform2D, rotate2D, worldToTangent }
