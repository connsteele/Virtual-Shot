// Monocular depth for a still (Depth Anything v2 small, ONNX, run in the page on WebGPU with transformers.js).
// The model is read from the dev server's /models/ mount (a copy in the spike folder on G:); nothing is fetched from
// Hugging Face at run time. Output is relative inverse depth ("disparity": bigger is nearer, unknown scale and shift).
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

env.localModelPath = '/models/';
env.allowRemoteModels = false;
env.allowLocalModels = true;

const MODEL = 'onnx-community/depth-anything-v2-small';
let pipe = null;

/** Disparity for an image URL: { w, h, data: Float32Array (row 0 at the top), ms }. The model's own grid (518 on the
 *  short side, multiple of 14), not the image's; callers sample it bilinearly. */
export async function estimateDisparity(url, { device = 'webgpu' } = {}) {
  const t0 = performance.now();
  pipe ??= await pipeline('depth-estimation', MODEL, { device, dtype: 'fp32' });
  const t1 = performance.now();
  const out = await pipe(await RawImage.fromURL(url));
  const t = out.predicted_depth, dims = t.dims, h = dims[dims.length - 2], w = dims[dims.length - 1];
  return { w, h, data: Float32Array.from(t.data), loadMs: t1 - t0, ms: performance.now() - t1 };
}
