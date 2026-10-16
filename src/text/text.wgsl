// ============================================================================
// text.wgsl — instanced quad pipeline for the custom editor surface.
//
// One pipeline, three quad kinds selected by aux.x:
//   0 — text coverage quad  (samples atlas .a, tinted by color)
//   1 — solid rect          (selection, caret, lines)
//   2 — rounded rect        (p0 = corner radius in px) — SDF, AA'd
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
  let px = instData.dst.xy + c * instData.dst.zw;
  let clip = vec2f(px.x / u.surface.x * 2.0 - 1.0, 1.0 - px.y / u.surface.y * 2.0);

  var o : VsOut;
  o.pos = vec4f(clip, 0.0, 1.0);
  o.uv = mix(instData.src.xy, instData.src.zw, c);
  o.local = c * instData.dst.zw;
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

  return vec4f(d.color.rgb * d.color.a, d.color.a);
}
