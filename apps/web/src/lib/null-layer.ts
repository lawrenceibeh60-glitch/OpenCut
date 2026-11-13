import type { ClipEffects } from './project-format'

/** Inherit a null controller's transform while preserving child effect/color/audio settings. */
export function inheritNullLayerTransform(child: ClipEffects, parent: ClipEffects): ClipEffects {
  const radians = parent.rotation * Math.PI / 180
  const x = child.positionX * parent.scaleX
  const y = child.positionY * parent.scaleY
  return {
    ...child,
    positionX: parent.positionX + x * Math.cos(radians) - y * Math.sin(radians),
    positionY: parent.positionY + x * Math.sin(radians) + y * Math.cos(radians),
    scaleX: child.scaleX * parent.scaleX,
    scaleY: child.scaleY * parent.scaleY,
    rotation: child.rotation + parent.rotation,
    opacity: child.opacity * parent.opacity / 100,
  }
}
