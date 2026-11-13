import type { ClipEffects } from './project-format'
import type { Lut3D } from './lut'


/** Build the source-fit, scale, rotation and translation matrix used by the GPU vertex shader. */
export function createLayerTransform(
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  effects: Pick<ClipEffects, 'scaleX' | 'scaleY' | 'rotation' | 'positionX' | 'positionY'>,
): Float32Array {
  if (![width, height, sourceWidth, sourceHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Canvas and source dimensions must be positive finite numbers')
  }
  const canvasAspect = width / height
  const sourceAspect = sourceWidth / sourceHeight
  const fitX = sourceAspect > canvasAspect ? 1 : sourceAspect / canvasAspect
  const fitY = sourceAspect > canvasAspect ? canvasAspect / sourceAspect : 1
  const scaleX = fitX * effects.scaleX
  const scaleY = fitY * effects.scaleY
  const radians = effects.rotation * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return new Float32Array([
    cosine * scaleX, sine * scaleX, 0,
    -sine * scaleY, cosine * scaleY, 0,
    effects.positionX / 50, -effects.positionY / 50, 1,
  ])
}

export type GpuLayer = {
  id: string
  source: HTMLImageElement | HTMLVideoElement
  effects: ClipEffects
  lut?: Lut3D
  lutStrength?: number
}

const vertexSource = `#version 300 es
in vec2 aPosition;
in vec2 aTexCoord;
uniform mat3 uTransform;
out vec2 vTexCoord;
void main() {
  vec3 position = uTransform * vec3(aPosition, 1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
  vTexCoord = aTexCoord;
}`

const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uOpacity;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uBlur;
uniform float uGrayscale;
uniform float uSepia;
uniform float uHue;
uniform sampler3D uLut;
uniform vec3 uLutDomainMin;
uniform vec3 uLutDomainMax;
uniform float uLutStrength;
uniform bool uUseLut;
in vec2 vTexCoord;
out vec4 outColor;

vec3 sampleLutTrilinear(vec3 coordinate) {
  ivec3 dimensions = textureSize(uLut, 0);
  vec3 position = clamp(coordinate, 0.0, 1.0) * vec3(dimensions - ivec3(1));
  ivec3 lower = ivec3(floor(position));
  ivec3 upper = min(lower + ivec3(1), dimensions - ivec3(1));
  vec3 fraction = fract(position);
  vec3 c00 = mix(texelFetch(uLut, ivec3(lower.x, lower.y, lower.z), 0).rgb, texelFetch(uLut, ivec3(upper.x, lower.y, lower.z), 0).rgb, fraction.x);
  vec3 c10 = mix(texelFetch(uLut, ivec3(lower.x, upper.y, lower.z), 0).rgb, texelFetch(uLut, ivec3(upper.x, upper.y, lower.z), 0).rgb, fraction.x);
  vec3 c01 = mix(texelFetch(uLut, ivec3(lower.x, lower.y, upper.z), 0).rgb, texelFetch(uLut, ivec3(upper.x, lower.y, upper.z), 0).rgb, fraction.x);
  vec3 c11 = mix(texelFetch(uLut, ivec3(lower.x, upper.y, upper.z), 0).rgb, texelFetch(uLut, ivec3(upper.x, upper.y, upper.z), 0).rgb, fraction.x);
  return mix(mix(c00, c10, fraction.y), mix(c01, c11, fraction.y), fraction.z);
}

vec4 sourceSample(vec2 uv) {
  if (uBlur <= 0.01) return texture(uTexture, uv);
  vec2 stepSize = uTexel * uBlur;
  vec4 total = vec4(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      total += texture(uTexture, uv + vec2(float(x), float(y)) * stepSize);
    }
  }
  return total / 9.0;
}

void main() {
  vec4 sampleColor = sourceSample(vTexCoord);
  vec3 color = sampleColor.rgb * uBrightness;
  color = (color - vec3(0.5)) * uContrast + vec3(0.5);
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, uSaturation);
  color = mix(color, vec3(luminance), uGrayscale);
  vec3 sepia = vec3(
    dot(color, vec3(0.393, 0.769, 0.189)),
    dot(color, vec3(0.349, 0.686, 0.168)),
    dot(color, vec3(0.272, 0.534, 0.131))
  );
  color = mix(color, sepia, uSepia);
  float angle = uHue * 0.01745329252;
  float c = cos(angle);
  float s = sin(angle);
  mat3 hueMatrix = mat3(
    0.213 + c * 0.787 - s * 0.213,
    0.213 - c * 0.213 + s * 0.143,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 - s * 0.715,
    0.715 + c * 0.285 + s * 0.140,
    0.715 - c * 0.715 + s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.072 - c * 0.072 - s * 0.283,
    0.072 + c * 0.928 + s * 0.072
  );
  color = clamp(hueMatrix * color, 0.0, 1.0);
  if (uUseLut && uLutStrength > 0.0) {
    vec3 lutCoordinate = clamp((color - uLutDomainMin) / (uLutDomainMax - uLutDomainMin), 0.0, 1.0);
    vec3 graded = sampleLutTrilinear(lutCoordinate);
    color = mix(color, graded, clamp(uLutStrength, 0.0, 1.0));
  }
  float alpha = sampleColor.a * uOpacity;
  outColor = vec4(color * alpha, alpha);
}`

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('WebGL could not allocate a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compilation error'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

export class WebGLCompositor {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly buffer: WebGLBuffer
  private readonly textures = new Map<string, WebGLTexture>()
  private readonly lutTextures = new Map<string, WebGLTexture>()
  private readonly locations: Record<string, WebGLUniformLocation>
  private readonly positionLocation: number
  private readonly texCoordLocation: number

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
    const program = gl.createProgram()
    if (!program) throw new Error('WebGL could not allocate a program')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) ?? 'Unknown shader link error'
      gl.deleteProgram(program)
      throw new Error(message)
    }
    this.program = program
    const buffer = gl.createBuffer()
    if (!buffer) throw new Error('WebGL could not allocate a vertex buffer')
    this.buffer = buffer
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1,
    ]), gl.STATIC_DRAW)
    this.positionLocation = gl.getAttribLocation(program, 'aPosition')
    this.texCoordLocation = gl.getAttribLocation(program, 'aTexCoord')
    gl.enableVertexAttribArray(this.positionLocation)
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(this.texCoordLocation)
    gl.vertexAttribPointer(this.texCoordLocation, 2, gl.FLOAT, false, 16, 8)
    const names = ['uTransform', 'uTexture', 'uTexel', 'uOpacity', 'uBrightness', 'uContrast', 'uSaturation', 'uBlur', 'uGrayscale', 'uSepia', 'uHue', 'uLut', 'uLutDomainMin', 'uLutDomainMax', 'uLutStrength', 'uUseLut']
    this.locations = Object.fromEntries(names.map((name) => {
      const location = gl.getUniformLocation(program, name)
      if (!location) throw new Error('WebGL uniform is missing: ' + name)
      return [name, location]
    }))
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.clearColor(0, 0, 0, 1)
  }

  render(width: number, height: number, layers: GpuLayer[]): void {
    const gl = this.gl
    gl.viewport(0, 0, width, height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(this.locations.uTexture, 0)
    gl.uniform1i(this.locations.uLut, 1)
    const activeIds = new Set(layers.map((layer) => layer.id))
    const activeLutIds = new Set(layers.flatMap((layer) => layer.lut && (layer.lutStrength ?? 1) > 0 ? [layer.lut.id] : []))
    for (const [id, texture] of this.lutTextures) {
      if (!activeLutIds.has(id)) { gl.deleteTexture(texture); this.lutTextures.delete(id) }
    }
    for (const [id, texture] of this.textures) {
      if (!activeIds.has(id)) {
        gl.deleteTexture(texture)
        this.textures.delete(id)
      }
    }
    for (const layer of layers) {
      const sourceWidth = layer.source instanceof HTMLVideoElement ? layer.source.videoWidth : layer.source.naturalWidth
      const sourceHeight = layer.source instanceof HTMLVideoElement ? layer.source.videoHeight : layer.source.naturalHeight
      if (!sourceWidth || !sourceHeight || (layer.source instanceof HTMLVideoElement && layer.source.readyState < 2)) continue
      let texture = this.textures.get(layer.id)
      if (!texture) {
        texture = gl.createTexture() ?? undefined
        if (!texture) continue
        this.textures.set(layer.id, texture)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      } else {
        gl.bindTexture(gl.TEXTURE_2D, texture)
      }
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, layer.source)
      } catch {
        continue
      }
      const effects = layer.effects
      if (layer.lut && (layer.lutStrength ?? 1) > 0) {
        let lutTexture = this.lutTextures.get(layer.lut.id)
        if (!lutTexture) {
          lutTexture = gl.createTexture() ?? undefined
          if (lutTexture) {
            this.lutTextures.set(layer.lut.id, lutTexture)
            gl.activeTexture(gl.TEXTURE1)
            gl.bindTexture(gl.TEXTURE_3D, lutTexture)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
            gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, layer.lut.size, layer.lut.size, layer.lut.size, 0, gl.RGBA, gl.FLOAT, layer.lut.data)
          }
        }
        if (lutTexture) {
          gl.activeTexture(gl.TEXTURE1)
          gl.bindTexture(gl.TEXTURE_3D, lutTexture)
          gl.uniform3fv(this.locations.uLutDomainMin, layer.lut.domainMin)
          gl.uniform3fv(this.locations.uLutDomainMax, layer.lut.domainMax)
          gl.uniform1f(this.locations.uLutStrength, Math.min(1, Math.max(0, layer.lutStrength ?? 1)))
          gl.uniform1i(this.locations.uUseLut, 1)
        } else {
          gl.uniform1i(this.locations.uUseLut, 0)
        }
      } else {
        gl.uniform1i(this.locations.uUseLut, 0)
      }
      gl.activeTexture(gl.TEXTURE0)
      const transform = createLayerTransform(width, height, sourceWidth, sourceHeight, effects)
      gl.uniformMatrix3fv(this.locations.uTransform, false, transform)
      gl.uniform2f(this.locations.uTexel, 1 / sourceWidth, 1 / sourceHeight)
      gl.uniform1f(this.locations.uOpacity, effects.opacity / 100)
      gl.uniform1f(this.locations.uBrightness, effects.brightness / 100)
      gl.uniform1f(this.locations.uContrast, effects.contrast / 100)
      gl.uniform1f(this.locations.uSaturation, effects.saturation / 100)
      gl.uniform1f(this.locations.uBlur, effects.blur)
      gl.uniform1f(this.locations.uGrayscale, effects.grayscale / 100)
      gl.uniform1f(this.locations.uSepia, effects.sepia / 100)
      gl.uniform1f(this.locations.uHue, effects.hueRotate)
      const blend = effects.blendMode
      if (blend === 'multiply') gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      else if (blend === 'screen') gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      else if (blend === 'add') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
  }

  dispose(): void {
    for (const texture of this.textures.values()) this.gl.deleteTexture(texture)
    for (const texture of this.lutTextures.values()) this.gl.deleteTexture(texture)
    this.textures.clear()
    this.lutTextures.clear()
    this.gl.deleteBuffer(this.buffer)
    this.gl.deleteProgram(this.program)
  }
}

export function createWebGLCompositor(canvas: HTMLCanvasElement): WebGLCompositor | null {
  const gl = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: true })
  return gl ? new WebGLCompositor(gl) : null
}
