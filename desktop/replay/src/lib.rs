//! The replay engine: executes a WebGPU capture (desktop/capture/gpu_capture.js) through wgpu. Used by the vs-replay
//! timing tool and by the Tauri shell's native viewport.
pub mod conv;
use conv::*;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub struct Objs {
    pub buffers: HashMap<u64, wgpu::Buffer>,
    pub textures: HashMap<u64, (wgpu::Texture, wgpu::TextureFormat)>,
    pub views: HashMap<u64, wgpu::TextureView>,
    pub samplers: HashMap<u64, wgpu::Sampler>,
    pub shaders: HashMap<u64, wgpu::ShaderModule>,
    pub bgls: HashMap<u64, wgpu::BindGroupLayout>,
    pub pls: HashMap<u64, wgpu::PipelineLayout>,
    pub rpipes: HashMap<u64, wgpu::RenderPipeline>,
    pub cpipes: HashMap<u64, wgpu::ComputePipeline>,
    pub bgs: HashMap<u64, wgpu::BindGroup>,
    pub cbs: HashMap<u64, wgpu::CommandBuffer>,
}

pub struct Pass { enc: u64, desc: Value, ops: Vec<(String, Value)>, compute: bool }

pub struct Replay<'b> {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub bin: &'b [u8],
    pub o: Objs,
    pub encoders: HashMap<u64, wgpu::CommandEncoder>,
    pub pass: Option<(u64, Pass)>,
    pub canvas: wgpu::Texture,
    pub canvas_format: wgpu::TextureFormat,
    pub unchecked: bool,
    pub skip_uploads: bool,
    // timing: a timestamp pair around every render pass while `timing` is on, labelled with the last "pass" note
    pub timing: bool,
    pub qs: wgpu::QuerySet,
    pub q_used: u32,
    pub q_labels: Vec<String>,
    pub label: String,
    pub stats: HashMap<&'static str, u64>,
}

pub const QMAX: u32 = 512;

impl<'b> Replay<'b> {
    pub fn blob(&self, v: &Value) -> Vec<u8> {
        if let Some(off) = v.get("$blob").and_then(|x| x.as_u64()) {
            let n = v["n"].as_u64().unwrap() as usize; return self.bin[off as usize..off as usize + n].to_vec();
        }
        if let Some(a) = v.get("$arr").and_then(|x| x.as_array()) {
            let ty = v["type"].as_str().unwrap_or("Float32Array");
            let mut out = Vec::new();
            for x in a { let x = x.as_f64().unwrap_or(0.0); match ty {
                "Float32Array" => out.extend_from_slice(&(x as f32).to_le_bytes()), "Uint32Array" => out.extend_from_slice(&(x as u32).to_le_bytes()),
                "Int32Array" => out.extend_from_slice(&(x as i32).to_le_bytes()), "Uint16Array" => out.extend_from_slice(&(x as u16).to_le_bytes()),
                "Int16Array" => out.extend_from_slice(&(x as i16).to_le_bytes()), "Uint8Array" | "Uint8ClampedArray" => out.push(x as u8),
                "Float64Array" => out.extend_from_slice(&x.to_le_bytes()), t => panic!("typed array {t}") } }
            return out;
        }
        panic!("not data: {v}");
    }
    pub fn elem_size(v: &Value) -> usize {
        if let Some(b) = v.get("bpe").and_then(|x| x.as_u64()) { return b as usize; }
        match v.get("type").and_then(|x| x.as_str()) { Some("Float64Array") => 8, Some("Float32Array" | "Uint32Array" | "Int32Array") => 4,
            Some("Uint16Array" | "Int16Array") => 2, Some(_) => 1, None => 1 }
    }
    pub fn module(&self, code: &str, label: Option<&str>) -> wgpu::ShaderModule {
        let desc = wgpu::ShaderModuleDescriptor { label, source: wgpu::ShaderSource::Wgsl(code.into()) };
        if self.unchecked { unsafe { self.device.create_shader_module_trusted(desc, wgpu::ShaderRuntimeChecks::unchecked()) } }
        else { self.device.create_shader_module(desc) }
    }

    pub fn exec(&mut self, op: &Value) {
        let t = op["t"].as_str().unwrap();
        let sid = op.get("s").and_then(|x| x.as_u64()).unwrap_or(0);
        let r = op.get("r").and_then(|x| x.as_u64()).unwrap_or(0);
        let a = &op["a"];
        *self.stats.entry(match t { "GPUQueue.copyExternalImageToTexture" => "uploads", "GPUQueue.writeBuffer" => "buffer writes", _ => "ops" }).or_default() += 1;
        // inside a pass: buffer its commands until end()
        if let Some((pid, p)) = self.pass.as_mut() {
            if sid == *pid && (t.starts_with("GPURenderPassEncoder.") || t.starts_with("GPUComputePassEncoder.")) {
                if t.ends_with(".end") { let (_, p) = self.pass.take().unwrap(); self.run_pass(p); } else { p.ops.push((t.to_string(), a.clone())); }
                return;
            }
        }
        match t {
            "note" => { if let Some(n) = a.as_str().and_then(|x| x.strip_prefix("pass ")) { self.label = n.to_string(); } }
            "device" | "canvas.configure" | "GPUTexture.destroy" | "GPUBuffer.destroy" => {}
            "canvas.texture" => { self.o.textures.insert(r, (self.canvas.clone(), self.canvas_format)); }
            "GPUDevice.createBuffer" => {
                if self.o.buffers.contains_key(&r) { return; }
                let d = &a[0];
                let mut usage = wgpu::BufferUsages::from_bits_truncate(u(d, "usage").unwrap() as u32);
                usage.remove(wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::MAP_WRITE); usage |= wgpu::BufferUsages::COPY_DST;
                let size = (u(d, "size").unwrap() + 3) & !3;
                let buf = self.device.create_buffer(&wgpu::BufferDescriptor { label: s_(d, "label"), size, usage, mapped_at_creation: false });
                self.o.buffers.insert(r, buf);
            }
            "mappedWrite" => { let data = self.blob(&a[1]); let off = a[0].as_u64().unwrap_or(0); self.queue.write_buffer(&self.o.buffers[&sid], off, &pad4(data)); }
            "GPUQueue.writeBuffer" => {
                let buf = oid(&a[0]).unwrap(); let boff = a[1].as_u64().unwrap_or(0);
                let es = Self::elem_size(&a[2]); let data = self.blob(&a[2]);
                let doff = a.get(3).and_then(|x| x.as_u64()).unwrap_or(0) as usize * es;
                let size = a.get(4).and_then(|x| x.as_u64()).map(|n| n as usize * es).unwrap_or(data.len() - doff);
                self.queue.write_buffer(&self.o.buffers[&buf], boff, &pad4(data[doff..doff + size].to_vec()));
            }
            "GPUDevice.createTexture" => {
                if self.o.textures.contains_key(&r) { return; }
                let d = &a[0]; let format = texture_format(s(d, "format").unwrap());
                let dim = match s(d, "dimension").unwrap_or("2d") { "1d" => wgpu::TextureDimension::D1, "3d" => wgpu::TextureDimension::D3, _ => wgpu::TextureDimension::D2 };
                let usage = wgpu::TextureUsages::from_bits_truncate(u(d, "usage").unwrap() as u32) | wgpu::TextureUsages::COPY_DST;
                let tex = self.device.create_texture(&wgpu::TextureDescriptor { label: s_(d, "label"), size: extent(&d["size"]), mip_level_count: u(d, "mipLevelCount").unwrap_or(1) as u32,
                    sample_count: u(d, "sampleCount").unwrap_or(1) as u32, dimension: dim, format, usage, view_formats: &[] });
                self.o.textures.insert(r, (tex, format));
            }
            "GPUTexture.createView" => {
                let (tex, _) = &self.o.textures[&sid]; let d = a.get(0).cloned().unwrap_or(Value::Null);
                let v = tex.create_view(&wgpu::TextureViewDescriptor { label: None, format: s(&d, "format").map(texture_format), dimension: view_dimension(s(&d, "dimension")),
                    usage: None, aspect: aspect(s(&d, "aspect")), base_mip_level: u(&d, "baseMipLevel").unwrap_or(0) as u32, mip_level_count: u(&d, "mipLevelCount").map(|x| x as u32),
                    base_array_layer: u(&d, "baseArrayLayer").unwrap_or(0) as u32, array_layer_count: u(&d, "arrayLayerCount").map(|x| x as u32) });
                self.o.views.insert(r, v);
            }
            "GPUDevice.createSampler" => {
                if self.o.samplers.contains_key(&r) { return; }
                let d = a.get(0).cloned().unwrap_or(Value::Null);
                let smp = self.device.create_sampler(&wgpu::SamplerDescriptor { label: None, address_mode_u: address(s(&d, "addressModeU")), address_mode_v: address(s(&d, "addressModeV")),
                    address_mode_w: address(s(&d, "addressModeW")), mag_filter: filter(s(&d, "magFilter")), min_filter: filter(s(&d, "minFilter")), mipmap_filter: mip_filter(s(&d, "mipmapFilter")),
                    lod_min_clamp: f(&d, "lodMinClamp").unwrap_or(0.0) as f32, lod_max_clamp: f(&d, "lodMaxClamp").unwrap_or(32.0) as f32, compare: compare(s(&d, "compare")),
                    anisotropy_clamp: u(&d, "maxAnisotropy").unwrap_or(1) as u16, border_color: None });
                self.o.samplers.insert(r, smp);
            }
            "GPUDevice.createShaderModule" => { if self.o.shaders.contains_key(&r) { return; } let m = self.module(s(&a[0], "code").unwrap(), s(&a[0], "label")); self.o.shaders.insert(r, m); }
            "GPUDevice.createBindGroupLayout" => {
                if self.o.bgls.contains_key(&r) { return; }
                let entries: Vec<wgpu::BindGroupLayoutEntry> = a[0]["entries"].as_array().unwrap().iter().map(|e| wgpu::BindGroupLayoutEntry {
                    binding: u(e, "binding").unwrap() as u32, visibility: wgpu::ShaderStages::from_bits_truncate(u(e, "visibility").unwrap() as u32), ty: binding_type(e), count: None }).collect();
                let l = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: s_(&a[0], "label"), entries: &entries });
                self.o.bgls.insert(r, l);
            }
            "GPUDevice.createPipelineLayout" => {
                if self.o.pls.contains_key(&r) { return; }
                let ls: Vec<Option<&wgpu::BindGroupLayout>> = a[0]["bindGroupLayouts"].as_array().unwrap().iter().map(|x| oid(x).map(|i| &self.o.bgls[&i])).collect();
                let pl = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: s_(&a[0], "label"), bind_group_layouts: &ls, immediate_size: 0 });
                self.o.pls.insert(r, pl);
            }
            "GPUDevice.createRenderPipeline" | "GPUDevice.createRenderPipelineAsync" => { if !self.o.rpipes.contains_key(&r) { let p = self.render_pipeline(&a[0]); self.o.rpipes.insert(r, p); } }
            "GPUDevice.createComputePipeline" | "GPUDevice.createComputePipelineAsync" => {
                if self.o.cpipes.contains_key(&r) { return; }
                let d = &a[0]; let c = &d["compute"];
                let p = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: s_(d, "label"), layout: oid(&d["layout"]).map(|i| &self.o.pls[&i]),
                    module: &self.o.shaders[&oid(&c["module"]).unwrap()], entry_point: s(c, "entryPoint"), compilation_options: Default::default(), cache: None });
                self.o.cpipes.insert(r, p);
            }
            "GPURenderPipeline.getBindGroupLayout" => { let l = self.o.rpipes[&sid].get_bind_group_layout(a[0].as_u64().unwrap() as u32); self.o.bgls.insert(r, l); }
            "GPUComputePipeline.getBindGroupLayout" => { let l = self.o.cpipes[&sid].get_bind_group_layout(a[0].as_u64().unwrap() as u32); self.o.bgls.insert(r, l); }
            "GPUDevice.createBindGroup" => {
                let d = &a[0];
                let ents = d["entries"].as_array().unwrap();
                let entries: Vec<wgpu::BindGroupEntry> = ents.iter().map(|e| {
                    let res = &e["resource"]; let binding = u(e, "binding").unwrap() as u32;
                    let resource = if let Some(i) = oid(res) {
                        if let Some(v) = self.o.views.get(&i) { wgpu::BindingResource::TextureView(v) }
                        else if let Some(sm) = self.o.samplers.get(&i) { wgpu::BindingResource::Sampler(sm) }
                        else if let Some(bf) = self.o.buffers.get(&i) { wgpu::BindingResource::Buffer(bf.as_entire_buffer_binding()) }
                        else { panic!("bind group resource {i}") }
                    } else if let Some(bv) = res.get("buffer") {
                        wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.o.buffers[&oid(bv).unwrap()], offset: u(res, "offset").unwrap_or(0), size: u(res, "size").and_then(wgpu::BufferSize::new) })
                    } else { panic!("bind group resource {res}") };
                    wgpu::BindGroupEntry { binding, resource }
                }).collect();
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: s_(d, "label"), layout: &self.o.bgls[&oid(&d["layout"]).unwrap()], entries: &entries });
                self.o.bgs.insert(r, bg);
            }
            "GPUDevice.createQuerySet" => {}
            "GPUDevice.createCommandEncoder" => { let e = self.device.create_command_encoder(&Default::default()); self.encoders.insert(r, e); }
            "GPUCommandEncoder.beginRenderPass" => { self.pass = Some((r, Pass { enc: sid, desc: a[0].clone(), ops: vec![], compute: false })); }
            "GPUCommandEncoder.beginComputePass" => { self.pass = Some((r, Pass { enc: sid, desc: a.get(0).cloned().unwrap_or(Value::Null), ops: vec![], compute: true })); }
            "GPUCommandEncoder.finish" => { let e = self.encoders.remove(&sid).unwrap(); self.o.cbs.insert(r, e.finish()); }
            "GPUQueue.submit" => { let cbs: Vec<wgpu::CommandBuffer> = a[0].as_array().unwrap().iter().filter_map(|x| self.o.cbs.remove(&oid(x).unwrap())).collect(); self.queue.submit(cbs); }
            "GPUCommandEncoder.copyTextureToTexture" => {
                let enc = self.encoders.get_mut(&sid).unwrap(); let (src, dst) = (&a[0], &a[1]);
                enc.copy_texture_to_texture(wgpu::TexelCopyTextureInfo { texture: &self.o.textures[&oid(&src["texture"]).unwrap()].0, mip_level: u(src, "mipLevel").unwrap_or(0) as u32, origin: origin(src.get("origin")), aspect: aspect(s(src, "aspect")) },
                    wgpu::TexelCopyTextureInfo { texture: &self.o.textures[&oid(&dst["texture"]).unwrap()].0, mip_level: u(dst, "mipLevel").unwrap_or(0) as u32, origin: origin(dst.get("origin")), aspect: aspect(s(dst, "aspect")) }, extent(&a[2]));
            }
            "GPUCommandEncoder.copyBufferToBuffer" => {
                let enc = self.encoders.get_mut(&sid).unwrap();
                enc.copy_buffer_to_buffer(&self.o.buffers[&oid(&a[0]).unwrap()], a[1].as_u64().unwrap(), &self.o.buffers[&oid(&a[2]).unwrap()], a[3].as_u64().unwrap(), a[4].as_u64());
            }
            "GPUCommandEncoder.copyTextureToBuffer" | "GPUCommandEncoder.resolveQuerySet" | "GPUCommandEncoder.clearBuffer" => {}   // readbacks and three's own timings
            "GPUQueue.writeTexture" => {
                let dst = &a[0]; let data = self.blob(&a[1]); let lay = &a[2];
                self.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &self.o.textures[&oid(&dst["texture"]).unwrap()].0, mip_level: u(dst, "mipLevel").unwrap_or(0) as u32, origin: origin(dst.get("origin")), aspect: aspect(s(dst, "aspect")) },
                    &data, wgpu::TexelCopyBufferLayout { offset: u(lay, "offset").unwrap_or(0), bytes_per_row: u(lay, "bytesPerRow").map(|x| x as u32), rows_per_image: u(lay, "rowsPerImage").map(|x| x as u32) }, extent(&a[3]));
            }
            "GPUQueue.copyExternalImageToTexture" => {
                if self.skip_uploads && self.timing { return; }
                let (src, dst) = (&a[0], &a[1]); let img = &src["source"];
                let (w, h) = (img["w"].as_u64().unwrap() as usize, img["h"].as_u64().unwrap() as usize);
                let mut px = self.blob(&img["$image"]);
                if b(src, "flipY").unwrap_or(false) { let row = w * 4; let mut fl = vec![0u8; px.len()]; for y in 0..h { fl[y * row..(y + 1) * row].copy_from_slice(&px[(h - 1 - y) * row..(h - y) * row]); } px = fl; }
                if b(dst, "premultipliedAlpha").unwrap_or(false) { for p in px.chunks_exact_mut(4) { let al = p[3] as u32; for c in 0..3 { p[c] = ((p[c] as u32 * al + 127) / 255) as u8; } } }
                let (tex, fmt) = &self.o.textures[&oid(&dst["texture"]).unwrap()];
                match fmt { wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => {}, wgpu::TextureFormat::Bgra8Unorm => { for p in px.chunks_exact_mut(4) { p.swap(0, 2); } },
                    other => panic!("external image into {other:?}") }
                let size = extent(&a[2]);
                self.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: tex, mip_level: u(dst, "mipLevel").unwrap_or(0) as u32, origin: origin(dst.get("origin")), aspect: wgpu::TextureAspect::All },
                    &px, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some((w * 4) as u32), rows_per_image: Some(h as u32) }, size);
            }
            other => panic!("unhandled op {other}"),
        }
    }

    pub fn render_pipeline(&self, d: &Value) -> wgpu::RenderPipeline {
        let v = &d["vertex"];
        let attrs: Vec<Vec<wgpu::VertexAttribute>> = v["buffers"].as_array().map(|bs| bs.iter().map(|bl| bl["attributes"].as_array().map(|x| x.as_slice()).unwrap_or(&[]).iter().map(|at| wgpu::VertexAttribute {
            format: vertex_format(s(at, "format").unwrap()), offset: u(at, "offset").unwrap_or(0), shader_location: u(at, "shaderLocation").unwrap() as u32 }).collect()).collect()).unwrap_or_default();
        let bufs: Vec<Option<wgpu::VertexBufferLayout>> = v["buffers"].as_array().map(|bs| bs.iter().enumerate().map(|(i, bl)| if bl.is_null() { None } else { Some(wgpu::VertexBufferLayout {
            array_stride: u(bl, "arrayStride").unwrap(), step_mode: if s(bl, "stepMode") == Some("instance") { wgpu::VertexStepMode::Instance } else { wgpu::VertexStepMode::Vertex },
            attributes: &attrs[i] }) }).collect()).unwrap_or_default();
        let fr = d.get("fragment");
        let targets: Vec<Option<wgpu::ColorTargetState>> = fr.and_then(|f| f["targets"].as_array()).map(|ts| ts.iter().map(|t| if t.is_null() { None } else { Some(wgpu::ColorTargetState {
            format: texture_format(s(t, "format").unwrap()), blend: blend(t.get("blend")), write_mask: wgpu::ColorWrites::from_bits_truncate(u(t, "writeMask").unwrap_or(15) as u32) }) }).collect()).unwrap_or_default();
        let pr = d.get("primitive").cloned().unwrap_or(Value::Null);
        let topology = match s(&pr, "topology").unwrap_or("triangle-list") { "point-list" => wgpu::PrimitiveTopology::PointList, "line-list" => wgpu::PrimitiveTopology::LineList,
            "line-strip" => wgpu::PrimitiveTopology::LineStrip, "triangle-strip" => wgpu::PrimitiveTopology::TriangleStrip, _ => wgpu::PrimitiveTopology::TriangleList };
        let ds = d.get("depthStencil").filter(|x| !x.is_null()).map(|x| wgpu::DepthStencilState { format: texture_format(s(x, "format").unwrap()),
            depth_write_enabled: b(x, "depthWriteEnabled"), depth_compare: compare(s(x, "depthCompare")),
            stencil: wgpu::StencilState { front: stencil_face(x.get("stencilFront")), back: stencil_face(x.get("stencilBack")), read_mask: u(x, "stencilReadMask").unwrap_or(0xffffffff) as u32,
                write_mask: u(x, "stencilWriteMask").unwrap_or(0xffffffff) as u32 },
            bias: wgpu::DepthBiasState { constant: f(x, "depthBias").unwrap_or(0.0) as i32, slope_scale: f(x, "depthBiasSlopeScale").unwrap_or(0.0) as f32, clamp: f(x, "depthBiasClamp").unwrap_or(0.0) as f32 } });
        let ms = d.get("multisample").cloned().unwrap_or(Value::Null);
        self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: s_(d, "label"), layout: oid(&d["layout"]).map(|i| &self.o.pls[&i]),
            vertex: wgpu::VertexState { module: &self.o.shaders[&oid(&v["module"]).unwrap()], entry_point: s(v, "entryPoint"), buffers: &bufs, compilation_options: Default::default() },
            fragment: fr.map(|f| wgpu::FragmentState { module: &self.o.shaders[&oid(&f["module"]).unwrap()], entry_point: s(f, "entryPoint"), targets: &targets, compilation_options: Default::default() }),
            primitive: wgpu::PrimitiveState { topology, strip_index_format: match s(&pr, "stripIndexFormat") { Some("uint16") => Some(wgpu::IndexFormat::Uint16), Some("uint32") => Some(wgpu::IndexFormat::Uint32), _ => None },
                front_face: if s(&pr, "frontFace") == Some("cw") { wgpu::FrontFace::Cw } else { wgpu::FrontFace::Ccw },
                cull_mode: match s(&pr, "cullMode") { Some("front") => Some(wgpu::Face::Front), Some("back") => Some(wgpu::Face::Back), _ => None },
                unclipped_depth: b(&pr, "unclippedDepth").unwrap_or(false), polygon_mode: wgpu::PolygonMode::Fill, conservative: false },
            depth_stencil: ds, multisample: wgpu::MultisampleState { count: u(&ms, "count").unwrap_or(1) as u32, mask: u(&ms, "mask").unwrap_or(0xffffffff),
                alpha_to_coverage_enabled: b(&ms, "alphaToCoverageEnabled").unwrap_or(false) },
            multiview_mask: None, cache: None })
    }

    pub fn run_pass(&mut self, p: Pass) {
        let o = &self.o;
        let enc = self.encoders.get_mut(&p.enc).unwrap();
        let ts = if self.timing && self.q_used + 2 <= QMAX { let i = self.q_used; self.q_used += 2; self.q_labels.push(self.label.clone()); Some(i) } else { None };
        if p.compute {
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: ts.map(|i| wgpu::ComputePassTimestampWrites { query_set: &self.qs, beginning_of_pass_write_index: Some(i), end_of_pass_write_index: Some(i + 1) }) });
            for (t, a) in &p.ops { match t.as_str() {
                "GPUComputePassEncoder.setPipeline" => cp.set_pipeline(&o.cpipes[&oid(&a[0]).unwrap()]),
                "GPUComputePassEncoder.setBindGroup" => cp.set_bind_group(a[0].as_u64().unwrap() as u32, oid(&a[1]).map(|i| &o.bgs[&i]), &offsets(a.get(2))),
                "GPUComputePassEncoder.dispatchWorkgroups" => cp.dispatch_workgroups(a[0].as_u64().unwrap() as u32, a.get(1).and_then(|x| x.as_u64()).unwrap_or(1) as u32, a.get(2).and_then(|x| x.as_u64()).unwrap_or(1) as u32),
                other => panic!("compute pass op {other}") } }
            return;
        }
        let d = &p.desc;
        let colors: Vec<Option<wgpu::RenderPassColorAttachment>> = d["colorAttachments"].as_array().unwrap().iter().map(|c| if c.is_null() { None } else { Some(wgpu::RenderPassColorAttachment {
            view: &o.views[&oid(&c["view"]).unwrap()], depth_slice: u(c, "depthSlice").map(|x| x as u32), resolve_target: c.get("resolveTarget").and_then(oid).map(|i| &o.views[&i]),
            ops: wgpu::Operations { load: if s(c, "loadOp") == Some("clear") { wgpu::LoadOp::Clear(color(c.get("clearValue"))) } else { wgpu::LoadOp::Load },
                store: if s(c, "storeOp") == Some("discard") { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store } } }) }).collect();
        let dsa = d.get("depthStencilAttachment").filter(|x| !x.is_null()).map(|x| wgpu::RenderPassDepthStencilAttachment { view: &o.views[&oid(&x["view"]).unwrap()],
            depth_ops: if b(x, "depthReadOnly").unwrap_or(false) || s(x, "depthLoadOp").is_none() { None } else { Some(wgpu::Operations {
                load: if s(x, "depthLoadOp") == Some("clear") { wgpu::LoadOp::Clear(f(x, "depthClearValue").unwrap_or(1.0) as f32) } else { wgpu::LoadOp::Load },
                store: if s(x, "depthStoreOp") == Some("discard") { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store } }) },
            stencil_ops: if b(x, "stencilReadOnly").unwrap_or(false) || s(x, "stencilLoadOp").is_none() { None } else { Some(wgpu::Operations {
                load: if s(x, "stencilLoadOp") == Some("clear") { wgpu::LoadOp::Clear(u(x, "stencilClearValue").unwrap_or(0) as u32) } else { wgpu::LoadOp::Load },
                store: if s(x, "stencilStoreOp") == Some("discard") { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store } }) } });
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &colors, depth_stencil_attachment: dsa, occlusion_query_set: None, multiview_mask: None,
            timestamp_writes: ts.map(|i| wgpu::RenderPassTimestampWrites { query_set: &self.qs, beginning_of_pass_write_index: Some(i), end_of_pass_write_index: Some(i + 1) }) });
        for (t, a) in &p.ops { match t.as_str() {
            "GPURenderPassEncoder.setPipeline" => rp.set_pipeline(&o.rpipes[&oid(&a[0]).unwrap()]),
            "GPURenderPassEncoder.setBindGroup" => rp.set_bind_group(a[0].as_u64().unwrap() as u32, oid(&a[1]).map(|i| &o.bgs[&i]), &offsets(a.get(2))),
            "GPURenderPassEncoder.setVertexBuffer" => { let bf = &o.buffers[&oid(&a[1]).unwrap()]; let off = a.get(2).and_then(|x| x.as_u64()).unwrap_or(0);
                match a.get(3).and_then(|x| x.as_u64()) { Some(n) => rp.set_vertex_buffer(a[0].as_u64().unwrap() as u32, bf.slice(off..off + n)), None => rp.set_vertex_buffer(a[0].as_u64().unwrap() as u32, bf.slice(off..)) } }
            "GPURenderPassEncoder.setIndexBuffer" => { let bf = &o.buffers[&oid(&a[0]).unwrap()]; let fmt = if a[1].as_str() == Some("uint16") { wgpu::IndexFormat::Uint16 } else { wgpu::IndexFormat::Uint32 };
                let off = a.get(2).and_then(|x| x.as_u64()).unwrap_or(0);
                match a.get(3).and_then(|x| x.as_u64()) { Some(n) => rp.set_index_buffer(bf.slice(off..off + n), fmt), None => rp.set_index_buffer(bf.slice(off..), fmt) } }
            "GPURenderPassEncoder.draw" => { let g = |i: usize, d: u64| a.get(i).and_then(|x| x.as_u64()).unwrap_or(d) as u32; let (fv, fi) = (g(2, 0), g(3, 0)); rp.draw(fv..fv + g(0, 0), fi..fi + g(1, 1)); }
            "GPURenderPassEncoder.drawIndexed" => { let g = |i: usize, d: i64| a.get(i).and_then(|x| x.as_i64()).unwrap_or(d); let (fi, fin) = (g(2, 0) as u32, g(4, 0) as u32);
                rp.draw_indexed(fi..fi + g(0, 0) as u32, g(3, 0) as i32, fin..fin + g(1, 1) as u32); }
            "GPURenderPassEncoder.setViewport" => { let g = |i: usize| a[i].as_f64().unwrap() as f32; rp.set_viewport(g(0), g(1), g(2), g(3), g(4), g(5)); }
            "GPURenderPassEncoder.setScissorRect" => { let g = |i: usize| a[i].as_u64().unwrap() as u32; rp.set_scissor_rect(g(0), g(1), g(2), g(3)); }
            "GPURenderPassEncoder.setBlendConstant" => rp.set_blend_constant(color(a.get(0))),
            "GPURenderPassEncoder.setStencilReference" => rp.set_stencil_reference(a[0].as_u64().unwrap() as u32),
            other => panic!("render pass op {other}") } }
    }

    /// Read the timestamps of the passes timed since `timing` was turned on: (label, ms) in order.
    pub fn take_times(&mut self) -> Vec<(String, f64)> {
        if self.q_used == 0 { return vec![]; }
        let n = self.q_used as u64;
        let res = self.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: n * 8, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let rd = self.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: n * 8, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut e = self.device.create_command_encoder(&Default::default());
        e.resolve_query_set(&self.qs, 0..self.q_used, &res, 0); e.copy_buffer_to_buffer(&res, 0, &rd, 0, n * 8);
        self.queue.submit([e.finish()]);
        rd.slice(..).map_async(wgpu::MapMode::Read, |_| {}); self.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let period = self.queue.get_timestamp_period() as f64;
        let t: Vec<u64> = rd.slice(..).get_mapped_range().unwrap().chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
        let out = self.q_labels.iter().enumerate().map(|(i, l)| (l.clone(), t[2 * i + 1].saturating_sub(t[2 * i]) as f64 * period / 1e6)).collect();
        self.q_used = 0; self.q_labels.clear();
        out
    }

    /// The canvas texture as RGBA8, top row first.
    pub fn read_canvas(&self) -> (u32, u32, Vec<u8>) {
        let sz = self.canvas.size(); let (w, h) = (sz.width, sz.height); let row = (w * 4).div_ceil(256) * 256;
        let buf = self.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (row * h) as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut e = self.device.create_command_encoder(&Default::default());
        e.copy_texture_to_buffer(self.canvas.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } }, sz);
        self.queue.submit([e.finish()]);
        buf.slice(..).map_async(wgpu::MapMode::Read, |_| {}); self.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let m = buf.slice(..).get_mapped_range().unwrap();
        let mut px = vec![0u8; (w * h * 4) as usize];
        for y in 0..h as usize { px[y * w as usize * 4..(y + 1) * w as usize * 4].copy_from_slice(&m[y * row as usize..y * row as usize + w as usize * 4]); }
        if self.canvas_format == wgpu::TextureFormat::Bgra8Unorm { for p in px.chunks_exact_mut(4) { p.swap(0, 2); } }
        (w, h, px)
    }
}

pub fn s_<'a>(v: &'a Value, k: &str) -> Option<&'a str> { s(v, k).filter(|x| !x.is_empty()) }
pub fn pad4(mut v: Vec<u8>) -> Vec<u8> { while v.len() % 4 != 0 { v.push(0); } v }
pub fn offsets(v: Option<&Value>) -> Vec<u32> {
    let Some(v) = v else { return vec![] };
    if let Some(a) = v.get("$arr").and_then(|x| x.as_array()) { return a.iter().map(|x| x.as_u64().unwrap() as u32).collect(); }
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).map(|x| x as u32).collect()).unwrap_or_default()
}

/// The capture's frames: (name, first op, end op) between each "frame <name>" note and the next "frame end";
/// and the index of the first frame's note (everything before it is setup).
pub fn frame_segments(ops: &[Value]) -> (Vec<(String, usize, usize)>, usize) {
    let mut frames: Vec<(String, usize, usize)> = vec![]; let mut first = ops.len();
    for (i, o) in ops.iter().enumerate() { if o["t"] == "note" { let n = o["a"].as_str().unwrap_or("");
        if let Some(name) = n.strip_prefix("frame ") { if name != "end" { first = first.min(i); frames.push((name.to_string(), i + 1, 0)); } else if let Some(l) = frames.last_mut() { l.2 = i; } } } }
    (frames, first)
}

/// Features the capture's device asked for, as wgpu features (intersected with the adapter's by the caller).
pub fn wanted_features(ops: &[Value]) -> wgpu::Features {
    let want = ops.iter().find(|o| o["t"] == "device").map(|o| o["a"]["features"].as_array().unwrap().iter().filter_map(|x| x.as_str()).map(String::from).collect::<Vec<_>>()).unwrap_or_default();
    let mut features = wgpu::Features::TIMESTAMP_QUERY;
    for name in &want { features |= match name.as_str() { "float32-filterable" => wgpu::Features::FLOAT32_FILTERABLE, "dual-source-blending" => wgpu::Features::DUAL_SOURCE_BLENDING,
        "shader-f16" => wgpu::Features::SHADER_F16, "depth32float-stencil8" => wgpu::Features::DEPTH32FLOAT_STENCIL8, "rg11b10ufloat-renderable" => wgpu::Features::RG11B10UFLOAT_RENDERABLE,
        "texture-compression-bc" => wgpu::Features::TEXTURE_COMPRESSION_BC, "depth-clip-control" => wgpu::Features::DEPTH_CLIP_CONTROL, "indirect-first-instance" => wgpu::Features::INDIRECT_FIRST_INSTANCE,
        "float32-blendable" => wgpu::Features::FLOAT32_BLENDABLE, _ => wgpu::Features::empty() }; }
    features
}

impl<'b> Replay<'b> {
    /// A replay on `device`, drawing the page's canvas into a texture of the capture's canvas size and format.
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, bin: &'b [u8], ops: &[Value], unchecked: bool) -> Self {
        let cfg = ops.iter().find(|o| o["t"] == "canvas.configure").map(|o| o["a"].clone()).unwrap();
        let canvas_format = texture_format(cfg["format"].as_str().unwrap());
        let canvas = device.create_texture(&wgpu::TextureDescriptor { label: Some("canvas"), size: wgpu::Extent3d { width: cfg["w"].as_u64().unwrap() as u32, height: cfg["h"].as_u64().unwrap() as u32, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: canvas_format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
        let qs = device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: QMAX });
        Replay { device, queue, bin, o: Objs::default(), encoders: HashMap::new(), pass: None, canvas, canvas_format, unchecked, skip_uploads: false, timing: false, qs, q_used: 0,
            q_labels: vec![], label: String::new(), stats: HashMap::new() }
    }
}
