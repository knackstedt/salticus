// ============================================================================
// text.wgsl — instanced quad pipeline for the custom editor surface.
//
// One pipeline, three quad kinds selected by aux.x:
//   0 — text coverage quad  (samples atlas .a, tinted by color)
//   1 — solid rect          (selection, caret, lines)
//   2 — rounded rect        (p0 = corner radius in px) — SDF, AA'd
//
//   3 — capsule segment      (dst = x0,y0,x1,y1 endpoints; aux.y = radius)
//   4 — ellipse              (dst = bounding box)
//
// Instances live in a storage buffer; the unit quad corner comes from
// vertex_index. Everything renders in surface pixel space; uniforms carry
// the surface size for the ortho transform. Output is premultiplied alpha.
// ============================================================================

struct Uniforms {
  surface : vec2f,   // px surface size
  time    : f32,
  _pad    : f32,
};

struct Instance {
  dst   : vec4f,     // x, y, w, h in px (surface space, y-down)
  src   : vec4f,     // u0, v0, u1, v1 normalized atlas coords (kind 0)
  color : vec4f,
  aux   : vec4f,     // kind, p0, p1, p2
  aux2  : vec4f,     // rotation: angle (rad), pivot x, pivot y, unused
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var<storage, read> inst : array<Instance>;
@group(0) @binding(2) var atlasTex : texture_2d<f32>;
@group(0) @binding(3) var atlasSamp : sampler;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) local : vec2f,   // px position within the quad
  @location(2) @interpolate(flat) iid : u32,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
  var corner = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let c = corner[vi];
  let instData = inst[ii];
  let kind = i32(instData.aux.x + 0.5);
  var px : vec2f;
  var local : vec2f;
  if (kind == 3) {
    // Capsule: dst = [x0, y0, x1, y1], aux.y = radius. Rotate the unit quad
    // onto the segment's axis with 1px AA padding.
    let p0 = instData.dst.xy;
    let p1 = instData.dst.zw;
    let axis = p1 - p0;
    let len = max(length(axis), 0.001);
    let dir = axis / len;
    let perp = vec2f(-dir.y, dir.x);
    let r = instData.aux.y + 1.0;
    let along = c.x * (len + 2.0 * r) - r;
    let across = (c.y - 0.5) * 2.0 * r;
    px = p0 + dir * along + perp * across;
    local = vec2f(along, across);
  } else {
    px = instData.dst.xy + c * instData.dst.zw;
    local = c * instData.dst.zw;
  }
  // Optional rotation about a pivot — applies to every primitive (text
  // quads included) so whole items can be drawn rotated by setting aux2.
  let ang = instData.aux2.x;
  if (ang != 0.0) {
    let pv = instData.aux2.yz;
    let sn = sin(ang);
    let co = cos(ang);
    let rel = px - pv;
    px = pv + vec2f(rel.x * co - rel.y * sn, rel.x * sn + rel.y * co);
  }
  let clip = vec2f(px.x / u.surface.x * 2.0 - 1.0, 1.0 - px.y / u.surface.y * 2.0);

  var o : VsOut;
  o.pos = vec4f(clip, 0.0, 1.0);
  o.uv = mix(instData.src.xy, instData.src.zw, c);
  o.local = local;
  o.iid = ii;
  return o;
}

fn sdRoundBox(p : vec2f, b : vec2f, r : f32) -> f32 {
  let q = abs(p) - b + vec2f(r, r);
  return length(max(q, vec2f(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4f {
  let d = inst[in.iid];
  let kind = i32(d.aux.x + 0.5);

  if (kind == 0) {
    let cov = textureSample(atlasTex, atlasSamp, in.uv).a;
    let a = cov * d.color.a;
    return vec4f(d.color.rgb * a, a);
  }

  if (kind == 2) {
    let half = d.dst.zw * 0.5;
    let sdf = sdRoundBox(in.local - half, half, d.aux.y);
    let aa = clamp(0.5 - sdf, 0.0, 1.0);
    let a = d.color.a * aa;
    return vec4f(d.color.rgb * a, a);
  }

  if (kind == 3) {
    // Capsule: distance from local (axis-space) to segment [0,len] minus r.
    let len = length(d.dst.zw - d.dst.xy);
    let r = d.aux.y;
    let cx = clamp(in.local.x, 0.0, len);
    let sdf = length(in.local - vec2f(cx, 0.0)) - r;
    let a = d.color.a * clamp(0.5 - sdf, 0.0, 1.0);
    return vec4f(d.color.rgb * a, a);
  }

  if (kind == 4) {
    // Ellipse fill in the dst bounding box — approximate sdf scaled by the
    // smaller half-extent keeps AA uniform for non-circular ellipses.
    let half = max(d.dst.zw * 0.5, vec2f(0.5, 0.5));
    let p = in.local - half;
    let k = length(p / half);
    let a = d.color.a * clamp((1.0 - k) * min(half.x, half.y) + 0.5, 0.0, 1.0);
    return vec4f(d.color.rgb * a, a);
  }

  return vec4f(d.color.rgb * d.color.a, d.color.a);
}
