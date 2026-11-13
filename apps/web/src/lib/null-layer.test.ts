import { describe, expect, it } from 'vitest'
import type { ClipEffects } from './project-format'
import { inheritNullLayerTransform } from './null-layer'
const fx=(patch:Partial<ClipEffects>={}):ClipEffects=>({volume:100,blendMode:'normal',brightness:100,contrast:100,saturation:100,blur:0,grayscale:0,sepia:0,hueRotate:0,opacity:100,positionX:0,positionY:0,scaleX:1,scaleY:1,rotation:0,...patch})
describe('null layer transforms',()=>{
 it('inherits translated, scaled, rotated and opacity transforms',()=>{const result=inheritNullLayerTransform(fx({positionX:10,positionY:5,scaleX:2,scaleY:3,rotation:15,opacity:80}),fx({positionX:4,positionY:-2,scaleX:2,scaleY:.5,rotation:30,opacity:50}));expect(result.positionX).toBeCloseTo(4+20*Math.cos(Math.PI/6)-2.5*Math.sin(Math.PI/6));expect(result.positionY).toBeCloseTo(-2+20*Math.sin(Math.PI/6)+2.5*Math.cos(Math.PI/6));expect(result.scaleX).toBe(4);expect(result.scaleY).toBe(1.5);expect(result.rotation).toBe(45);expect(result.opacity).toBe(40)})
 it('does not inherit color or audio adjustments',()=>{const result=inheritNullLayerTransform(fx({brightness:125,volume:60}),fx({brightness:20,volume:0}));expect(result.brightness).toBe(125);expect(result.volume).toBe(60)})
})
