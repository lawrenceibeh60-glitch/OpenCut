import type { ClipEffects, ClipKeyframe } from './project-format'

export type AnimatedEffectProperty = ClipKeyframe['property']

export function evaluateKeyframes(
  baseValue: number,
  keyframes: ClipKeyframe[],
  property: AnimatedEffectProperty,
  frame: number,
): number {
  const keys = keyframes.filter((key) => key.property === property).sort((a, b) => a.frame - b.frame)
  if (keys.length === 0) return baseValue
  if (frame <= keys[0].frame) return keys[0].value
  const last = keys[keys.length - 1]
  if (frame >= last.frame) return last.value
  for (let index = 0; index < keys.length - 1; index += 1) {
    const left = keys[index]
    const right = keys[index + 1]
    if (frame < left.frame || frame > right.frame) continue
    if (frame === right.frame) return right.value
    if (left.interpolation === 'hold') return left.value
    const progress = (frame - left.frame) / (right.frame - left.frame)
    return left.value + (right.value - left.value) * progress
  }
  return last.value
}

export function evaluateClipEffects(
  base: ClipEffects,
  keyframes: ClipKeyframe[] | undefined,
  frame: number,
): ClipEffects {
  if (!keyframes?.length) return base
  return {
    ...base,
    opacity: evaluateKeyframes(base.opacity, keyframes, 'opacity', frame),
    volume: evaluateKeyframes(base.volume, keyframes, 'volume', frame),
    positionX: evaluateKeyframes(base.positionX, keyframes, 'positionX', frame),
    positionY: evaluateKeyframes(base.positionY, keyframes, 'positionY', frame),
    scaleX: evaluateKeyframes(base.scaleX, keyframes, 'scaleX', frame),
    scaleY: evaluateKeyframes(base.scaleY, keyframes, 'scaleY', frame),
    rotation: evaluateKeyframes(base.rotation, keyframes, 'rotation', frame),
  }
}
