//! WebGPU (JavaScript descriptor) names to wgpu types. Only what the capture contains needs to be here; anything
//! unknown fails loudly so a new three.js feature is noticed.
use serde_json::Value;

pub fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> { v.get(k).and_then(|x| x.as_str()) }
pub fn u(v: &Value, k: &str) -> Option<u64> { v.get(k).and_then(|x| x.as_f64()).map(|x| x as u64) }
pub fn f(v: &Value, k: &str) -> Option<f64> { v.get(k).and_then(|x| x.as_f64()) }
pub fn b(v: &Value, k: &str) -> Option<bool> { v.get(k).and_then(|x| x.as_bool()) }
pub fn oid(v: &Value) -> Option<u64> { v.get("$").and_then(|x| x.as_u64()) }

pub fn texture_format(name: &str) -> wgpu::TextureFormat {
    use wgpu::TextureFormat as F;
    match name {
        "r8unorm" => F::R8Unorm, "r8snorm" => F::R8Snorm, "r8uint" => F::R8Uint, "r8sint" => F::R8Sint,
        "r16uint" => F::R16Uint, "r16sint" => F::R16Sint, "r16float" => F::R16Float,
        "rg8unorm" => F::Rg8Unorm, "rg8snorm" => F::Rg8Snorm, "rg8uint" => F::Rg8Uint, "rg8sint" => F::Rg8Sint,
        "r32uint" => F::R32Uint, "r32sint" => F::R32Sint, "r32float" => F::R32Float,
        "rg16uint" => F::Rg16Uint, "rg16sint" => F::Rg16Sint, "rg16float" => F::Rg16Float,
        "rgba8unorm" => F::Rgba8Unorm, "rgba8unorm-srgb" => F::Rgba8UnormSrgb, "rgba8snorm" => F::Rgba8Snorm,
        "rgba8uint" => F::Rgba8Uint, "rgba8sint" => F::Rgba8Sint, "bgra8unorm" => F::Bgra8Unorm, "bgra8unorm-srgb" => F::Bgra8UnormSrgb,
        "rgb10a2unorm" => F::Rgb10a2Unorm, "rg11b10ufloat" => F::Rg11b10Ufloat,
        "rg32uint" => F::Rg32Uint, "rg32sint" => F::Rg32Sint, "rg32float" => F::Rg32Float,
        "rgba16uint" => F::Rgba16Uint, "rgba16sint" => F::Rgba16Sint, "rgba16float" => F::Rgba16Float,
        "rgba32uint" => F::Rgba32Uint, "rgba32sint" => F::Rgba32Sint, "rgba32float" => F::Rgba32Float,
        "depth16unorm" => F::Depth16Unorm, "depth24plus" => F::Depth24Plus, "depth24plus-stencil8" => F::Depth24PlusStencil8,
        "depth32float" => F::Depth32Float, "depth32float-stencil8" => F::Depth32FloatStencil8, "stencil8" => F::Stencil8,
        other => panic!("texture format {other}"),
    }
}

pub fn vertex_format(name: &str) -> wgpu::VertexFormat {
    use wgpu::VertexFormat as V;
    match name {
        "float32" => V::Float32, "float32x2" => V::Float32x2, "float32x3" => V::Float32x3, "float32x4" => V::Float32x4,
        "uint32" => V::Uint32, "uint32x2" => V::Uint32x2, "uint32x3" => V::Uint32x3, "uint32x4" => V::Uint32x4,
        "sint32" => V::Sint32, "sint32x2" => V::Sint32x2, "sint32x3" => V::Sint32x3, "sint32x4" => V::Sint32x4,
        "float16x2" => V::Float16x2, "float16x4" => V::Float16x4, "uint16x2" => V::Uint16x2, "uint16x4" => V::Uint16x4,
        "sint16x2" => V::Sint16x2, "sint16x4" => V::Sint16x4, "unorm16x2" => V::Unorm16x2, "unorm16x4" => V::Unorm16x4,
        "snorm16x2" => V::Snorm16x2, "snorm16x4" => V::Snorm16x4, "uint8x2" => V::Uint8x2, "uint8x4" => V::Uint8x4,
        "sint8x2" => V::Sint8x2, "sint8x4" => V::Sint8x4, "unorm8x2" => V::Unorm8x2, "unorm8x4" => V::Unorm8x4,
        "snorm8x2" => V::Snorm8x2, "snorm8x4" => V::Snorm8x4,
        other => panic!("vertex format {other}"),
    }
}

pub fn compare(name: Option<&str>) -> Option<wgpu::CompareFunction> {
    use wgpu::CompareFunction as C;
    Some(match name? {
        "never" => C::Never, "less" => C::Less, "equal" => C::Equal, "less-equal" => C::LessEqual, "greater" => C::Greater,
        "not-equal" => C::NotEqual, "greater-equal" => C::GreaterEqual, "always" => C::Always, other => panic!("compare {other}"),
    })
}

fn blend_factor(n: &str) -> wgpu::BlendFactor {
    use wgpu::BlendFactor as B;
    match n {
        "zero" => B::Zero, "one" => B::One, "src" => B::Src, "one-minus-src" => B::OneMinusSrc, "src-alpha" => B::SrcAlpha,
        "one-minus-src-alpha" => B::OneMinusSrcAlpha, "dst" => B::Dst, "one-minus-dst" => B::OneMinusDst, "dst-alpha" => B::DstAlpha,
        "one-minus-dst-alpha" => B::OneMinusDstAlpha, "src-alpha-saturated" => B::SrcAlphaSaturated, "constant" => B::Constant,
        "one-minus-constant" => B::OneMinusConstant, "src1" => B::Src1, "one-minus-src1" => B::OneMinusSrc1, "src1-alpha" => B::Src1Alpha,
        "one-minus-src1-alpha" => B::OneMinusSrc1Alpha, other => panic!("blend factor {other}"),
    }
}
fn blend_component(v: &Value) -> wgpu::BlendComponent {
    wgpu::BlendComponent {
        src_factor: s(v, "srcFactor").map(blend_factor).unwrap_or(wgpu::BlendFactor::One),
        dst_factor: s(v, "dstFactor").map(blend_factor).unwrap_or(wgpu::BlendFactor::Zero),
        operation: match s(v, "operation").unwrap_or("add") {
            "add" => wgpu::BlendOperation::Add, "subtract" => wgpu::BlendOperation::Subtract, "reverse-subtract" => wgpu::BlendOperation::ReverseSubtract,
            "min" => wgpu::BlendOperation::Min, "max" => wgpu::BlendOperation::Max, o => panic!("blend op {o}"),
        },
    }
}
pub fn blend(v: Option<&Value>) -> Option<wgpu::BlendState> {
    let v = v?;
    Some(wgpu::BlendState { color: v.get("color").map(blend_component).unwrap_or(wgpu::BlendComponent::REPLACE),
        alpha: v.get("alpha").map(blend_component).unwrap_or(wgpu::BlendComponent::REPLACE) })
}

pub fn stencil_face(v: Option<&Value>) -> wgpu::StencilFaceState {
    let Some(v) = v else { return wgpu::StencilFaceState::IGNORE };
    let op = |k: &str| match s(v, k).unwrap_or("keep") {
        "keep" => wgpu::StencilOperation::Keep, "zero" => wgpu::StencilOperation::Zero, "replace" => wgpu::StencilOperation::Replace,
        "invert" => wgpu::StencilOperation::Invert, "increment-clamp" => wgpu::StencilOperation::IncrementClamp,
        "decrement-clamp" => wgpu::StencilOperation::DecrementClamp, "increment-wrap" => wgpu::StencilOperation::IncrementWrap,
        "decrement-wrap" => wgpu::StencilOperation::DecrementWrap, o => panic!("stencil op {o}"),
    };
    wgpu::StencilFaceState { compare: compare(s(v, "compare")).unwrap_or(wgpu::CompareFunction::Always), fail_op: op("failOp"), depth_fail_op: op("depthFailOp"), pass_op: op("passOp") }
}

pub fn view_dimension(n: Option<&str>) -> Option<wgpu::TextureViewDimension> {
    use wgpu::TextureViewDimension as D;
    Some(match n? { "1d" => D::D1, "2d" => D::D2, "2d-array" => D::D2Array, "cube" => D::Cube, "cube-array" => D::CubeArray, "3d" => D::D3, o => panic!("view dimension {o}") })
}

pub fn address(n: Option<&str>) -> wgpu::AddressMode {
    match n.unwrap_or("clamp-to-edge") { "clamp-to-edge" => wgpu::AddressMode::ClampToEdge, "repeat" => wgpu::AddressMode::Repeat,
        "mirror-repeat" => wgpu::AddressMode::MirrorRepeat, o => panic!("address mode {o}") }
}
pub fn filter(n: Option<&str>) -> wgpu::FilterMode { if n == Some("linear") { wgpu::FilterMode::Linear } else { wgpu::FilterMode::Nearest } }
pub fn mip_filter(n: Option<&str>) -> wgpu::MipmapFilterMode { if n == Some("linear") { wgpu::MipmapFilterMode::Linear } else { wgpu::MipmapFilterMode::Nearest } }

pub fn binding_type(e: &Value) -> wgpu::BindingType {
    if let Some(bu) = e.get("buffer") {
        let ty = match s(bu, "type").unwrap_or("uniform") {
            "uniform" => wgpu::BufferBindingType::Uniform, "storage" => wgpu::BufferBindingType::Storage { read_only: false },
            "read-only-storage" => wgpu::BufferBindingType::Storage { read_only: true }, o => panic!("buffer binding {o}"),
        };
        return wgpu::BindingType::Buffer { ty, has_dynamic_offset: b(bu, "hasDynamicOffset").unwrap_or(false),
            min_binding_size: u(bu, "minBindingSize").and_then(wgpu::BufferSize::new) };
    }
    if let Some(sa) = e.get("sampler") {
        return wgpu::BindingType::Sampler(match s(sa, "type").unwrap_or("filtering") {
            "filtering" => wgpu::SamplerBindingType::Filtering, "non-filtering" => wgpu::SamplerBindingType::NonFiltering,
            "comparison" => wgpu::SamplerBindingType::Comparison, o => panic!("sampler binding {o}") });
    }
    if let Some(t) = e.get("texture") {
        let sample_type = match s(t, "sampleType").unwrap_or("float") {
            "float" => wgpu::TextureSampleType::Float { filterable: true }, "unfilterable-float" => wgpu::TextureSampleType::Float { filterable: false },
            "depth" => wgpu::TextureSampleType::Depth, "sint" => wgpu::TextureSampleType::Sint, "uint" => wgpu::TextureSampleType::Uint, o => panic!("sample type {o}"),
        };
        return wgpu::BindingType::Texture { sample_type, view_dimension: view_dimension(s(t, "viewDimension")).unwrap_or(wgpu::TextureViewDimension::D2),
            multisampled: b(t, "multisampled").unwrap_or(false) };
    }
    if let Some(t) = e.get("storageTexture") {
        let access = match s(t, "access").unwrap_or("write-only") {
            "write-only" => wgpu::StorageTextureAccess::WriteOnly, "read-only" => wgpu::StorageTextureAccess::ReadOnly,
            "read-write" => wgpu::StorageTextureAccess::ReadWrite, o => panic!("storage access {o}"),
        };
        return wgpu::BindingType::StorageTexture { access, format: texture_format(s(t, "format").unwrap()),
            view_dimension: view_dimension(s(t, "viewDimension")).unwrap_or(wgpu::TextureViewDimension::D2) };
    }
    panic!("binding layout entry {e}");
}

pub fn extent(v: &Value) -> wgpu::Extent3d {
    if let Some(a) = v.as_array() {
        let g = |i: usize, d: u32| a.get(i).and_then(|x| x.as_u64()).map(|x| x as u32).unwrap_or(d);
        return wgpu::Extent3d { width: g(0, 1), height: g(1, 1), depth_or_array_layers: g(2, 1) };
    }
    wgpu::Extent3d { width: u(v, "width").unwrap_or(1) as u32, height: u(v, "height").unwrap_or(1) as u32, depth_or_array_layers: u(v, "depthOrArrayLayers").unwrap_or(1) as u32 }
}
pub fn origin(v: Option<&Value>) -> wgpu::Origin3d {
    let Some(v) = v else { return wgpu::Origin3d::ZERO };
    if let Some(a) = v.as_array() { let g = |i: usize| a.get(i).and_then(|x| x.as_u64()).unwrap_or(0) as u32; return wgpu::Origin3d { x: g(0), y: g(1), z: g(2) }; }
    wgpu::Origin3d { x: u(v, "x").unwrap_or(0) as u32, y: u(v, "y").unwrap_or(0) as u32, z: u(v, "z").unwrap_or(0) as u32 }
}
pub fn color(v: Option<&Value>) -> wgpu::Color {
    let Some(v) = v else { return wgpu::Color::TRANSPARENT };
    if let Some(a) = v.as_array() { let g = |i: usize| a.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0); return wgpu::Color { r: g(0), g: g(1), b: g(2), a: g(3) }; }
    wgpu::Color { r: f(v, "r").unwrap_or(0.0), g: f(v, "g").unwrap_or(0.0), b: f(v, "b").unwrap_or(0.0), a: f(v, "a").unwrap_or(0.0) }
}
pub fn aspect(n: Option<&str>) -> wgpu::TextureAspect {
    match n.unwrap_or("all") { "all" => wgpu::TextureAspect::All, "depth-only" => wgpu::TextureAspect::DepthOnly, "stencil-only" => wgpu::TextureAspect::StencilOnly, o => panic!("aspect {o}") }
}
