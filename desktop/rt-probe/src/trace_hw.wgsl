// Hardware tracer: the driver's acceleration structure through ray queries (DXR inline ray tracing / Vulkan ray query).
@group(0) @binding(3) var acc: acceleration_structure;

fn trace(o: vec3f, d: vec3f, tmax: f32, any: bool) -> vec2f {
  var rq: ray_query;
  let flags = select(RAY_FLAG_FORCE_OPAQUE, RAY_FLAG_FORCE_OPAQUE | RAY_FLAG_TERMINATE_ON_FIRST_HIT, any);
  rayQueryInitialize(&rq, acc, RayDesc(flags, 0xFFu, 1e-5, tmax, o, d));
  rayQueryProceed(&rq);
  let h = rayQueryGetCommittedIntersection(&rq);
  if (h.kind == RAY_QUERY_INTERSECTION_NONE) { return vec2f(-1.0, 0.0); }
  return vec2f(h.t, bitcast<f32>(h.primitive_index));
}
