import type { ClipEffects, ClipKeyframe } from './project-format'

export type CreativePresetKind = 'grade' | 'transition' | 'motion' | 'style'
export type CreativeMotion = {
  edge: 'in' | 'out'
  property: ClipKeyframe['property']
  from: number
  to: number
  frames: number
}
export type CreativePreset = {
  id: string
  name: string
  kind: CreativePresetKind
  description: string
  effects?: Partial<ClipEffects>
  motion?: CreativeMotion[]
}

const grades: Array<[string, string, Partial<ClipEffects>]> = [
  ['Cinematic Teal', 'Cool shadows with warm highlights', {brightness:102,contrast:118,saturation:112,hueRotate:4}],
  ['Golden Hour', 'Warm sunlit color', {brightness:106,contrast:108,saturation:118,sepia:12,hueRotate:350}],
  ['Nordic Cool', 'Clean blue-gray atmosphere', {brightness:104,contrast:106,saturation:82,hueRotate:194}],
  ['Bleach Bypass', 'Hard contrast and restrained color', {contrast:145,saturation:58,brightness:98}],
  ['Vintage Fade', 'Lifted, soft vintage image', {contrast:86,saturation:78,brightness:108,sepia:16}],
  ['Noir Mono', 'High-contrast monochrome', {grayscale:100,contrast:138,brightness:102}],
  ['Soft Mono', 'Gentle black and white', {grayscale:100,contrast:92,brightness:108}],
  ['Desert Amber', 'Amber warmth and rich contrast', {sepia:28,saturation:112,contrast:112,brightness:102}],
  ['Forest Deep', 'Dense greens and cinematic shadows', {hueRotate:18,saturation:112,contrast:118,brightness:96}],
  ['Night City', 'Cool night palette', {brightness:82,contrast:132,saturation:116,hueRotate:205}],
  ['Pastel Air', 'Soft low-contrast pastel look', {brightness:112,contrast:82,saturation:76}],
  ['Punchy Commercial', 'Bright, crisp, vivid finish', {brightness:106,contrast:124,saturation:132}],
  ['Warm Portrait', 'Soft warm skin-friendly starting point', {brightness:108,contrast:96,saturation:104,sepia:7}],
  ['Cool Documentary', 'Neutral cool documentary tone', {brightness:100,contrast:108,saturation:90,hueRotate:188}],
  ['Sunset Rose', 'Warm magenta sunset palette', {brightness:103,contrast:110,saturation:120,hueRotate:338}],
  ['Muted Earth', 'Natural restrained earth tones', {saturation:68,contrast:104,sepia:8}],
  ['Retro 70s', 'Warm faded analog character', {brightness:108,contrast:88,saturation:94,sepia:24}],
  ['Chrome', 'Cool metallic contrast', {brightness:98,contrast:132,saturation:72,hueRotate:198}],
  ['Bleu', 'Blue monochrome treatment', {grayscale:34,hueRotate:205,saturation:126,contrast:112}],
  ['Copper', 'Copper warmth', {sepia:35,hueRotate:18,saturation:110,contrast:108}],
  ['Matte Cinema', 'Soft blacks and restrained saturation', {brightness:106,contrast:82,saturation:86}],
  ['Vivid Travel', 'Vibrant travel footage', {brightness:105,contrast:112,saturation:145}],
  ['Clean Skin', 'Neutral, gentle contrast', {brightness:104,contrast:96,saturation:96}],
  ['Arctic', 'Cold blue highlights feel', {brightness:104,contrast:112,saturation:88,hueRotate:210}],
]

const transitionSpecs: Array<[string, string, CreativeMotion[]]> = [
  ['Fade In','Smooth opacity reveal',[{edge:'in',property:'opacity',from:0,to:100,frames:18}]],
  ['Fade Out','Smooth opacity exit',[{edge:'out',property:'opacity',from:100,to:0,frames:18}]],
  ['Cross Fade','Fade in and out',[{edge:'in',property:'opacity',from:0,to:100,frames:18},{edge:'out',property:'opacity',from:100,to:0,frames:18}]],
  ['Zoom In','Scale up into the shot',[{edge:'in',property:'scaleX',from:.72,to:1,frames:18},{edge:'in',property:'scaleY',from:.72,to:1,frames:18}]],
  ['Zoom Out','Scale away from the shot',[{edge:'out',property:'scaleX',from:1,to:1.25,frames:18},{edge:'out',property:'scaleY',from:1,to:1.25,frames:18}]],
  ['Push Left','Enter from the right',[{edge:'in',property:'positionX',from:100,to:0,frames:18}]],
  ['Push Right','Enter from the left',[{edge:'in',property:'positionX',from:-100,to:0,frames:18}]],
  ['Push Up','Enter from below',[{edge:'in',property:'positionY',from:100,to:0,frames:18}]],
  ['Push Down','Enter from above',[{edge:'in',property:'positionY',from:-100,to:0,frames:18}]],
  ['Slide Left','Slide out to the left',[{edge:'out',property:'positionX',from:0,to:-100,frames:18}]],
  ['Slide Right','Slide out to the right',[{edge:'out',property:'positionX',from:0,to:100,frames:18}]],
  ['Slide Up','Slide out upward',[{edge:'out',property:'positionY',from:0,to:-100,frames:18}]],
  ['Slide Down','Slide out downward',[{edge:'out',property:'positionY',from:0,to:100,frames:18}]],
  ['Pop In','Fast scale pop',[{edge:'in',property:'scaleX',from:.45,to:1,frames:10},{edge:'in',property:'scaleY',from:.45,to:1,frames:10},{edge:'in',property:'opacity',from:0,to:100,frames:10}]],
  ['Spin In','Rotate into place',[{edge:'in',property:'rotation',from:-90,to:0,frames:20},{edge:'in',property:'opacity',from:0,to:100,frames:20}]],
  ['Spin Out','Rotate away',[{edge:'out',property:'rotation',from:0,to:90,frames:20},{edge:'out',property:'opacity',from:100,to:0,frames:20}]],
  ['Tilt In','Small angled reveal',[{edge:'in',property:'rotation',from:-18,to:0,frames:16},{edge:'in',property:'scaleX',from:.92,to:1,frames:16},{edge:'in',property:'scaleY',from:.92,to:1,frames:16}]],
  ['Drift In','Gentle upward drift',[{edge:'in',property:'positionY',from:18,to:0,frames:24},{edge:'in',property:'opacity',from:0,to:100,frames:24}]],
  ['Drift Out','Gentle upward exit',[{edge:'out',property:'positionY',from:0,to:-18,frames:24},{edge:'out',property:'opacity',from:100,to:0,frames:24}]],
  ['Punch In','Aggressive zoom punch',[{edge:'in',property:'scaleX',from:1.35,to:1,frames:8},{edge:'in',property:'scaleY',from:1.35,to:1,frames:8}]],
  ['Pull Back','Reveal by scaling down',[{edge:'in',property:'scaleX',from:1.3,to:1,frames:22},{edge:'in',property:'scaleY',from:1.3,to:1,frames:22}]],
  ['Drop In','Drop down into frame',[{edge:'in',property:'positionY',from:-90,to:0,frames:18}]],
  ['Rise Out','Lift away from frame',[{edge:'out',property:'positionY',from:0,to:-90,frames:18}]],
  ['Blur Reveal','Soft reveal with scale and opacity',[{edge:'in',property:'blur',from:12,to:0,frames:18},{edge:'in',property:'opacity',from:0,to:100,frames:18}]],
  ['Micro Zoom','Subtle cinematic scale',[{edge:'in',property:'scaleX',from:.96,to:1,frames:30},{edge:'in',property:'scaleY',from:.96,to:1,frames:30}]],
]

const motionSpecs: Array<[string,string,CreativeMotion[]]> = [
  ['Title Rise','Title rises into view',[{edge:'in',property:'positionY',from:24,to:0,frames:20},{edge:'in',property:'opacity',from:0,to:100,frames:20}]],
  ['Title Drop','Title drops into view',[{edge:'in',property:'positionY',from:-24,to:0,frames:20},{edge:'in',property:'opacity',from:0,to:100,frames:20}]],
  ['Title Scale','Title scales into view',[{edge:'in',property:'scaleX',from:.6,to:1,frames:16},{edge:'in',property:'scaleY',from:.6,to:1,frames:16}]],
  ['Title Fade','Elegant title fade',[{edge:'in',property:'opacity',from:0,to:100,frames:24}]],
  ['Title Drift','Soft horizontal title drift',[{edge:'in',property:'positionX',from:-16,to:0,frames:24},{edge:'in',property:'opacity',from:0,to:100,frames:24}]],
  ['Title Exit','Title fades and lifts',[{edge:'out',property:'positionY',from:0,to:-20,frames:16},{edge:'out',property:'opacity',from:100,to:0,frames:16}]],
  ['Caption Pop','Compact caption pop',[{edge:'in',property:'scaleX',from:.86,to:1,frames:8},{edge:'in',property:'scaleY',from:.86,to:1,frames:8},{edge:'in',property:'opacity',from:0,to:100,frames:8}]],
  ['Caption Slide','Caption slides up',[{edge:'in',property:'positionY',from:12,to:0,frames:12}]],
  ['Kinetic Push','Strong directional title motion',[{edge:'in',property:'positionX',from:70,to:0,frames:14}]],
  ['Kinetic Pull','Title pulls into position',[{edge:'in',property:'positionX',from:-70,to:0,frames:14}]],
  ['Neon Reveal','Neon title opacity reveal',[{edge:'in',property:'opacity',from:0,to:100,frames:12}]],
  ['Type Card','Editorial card entrance',[{edge:'in',property:'positionY',from:30,to:0,frames:24},{edge:'in',property:'opacity',from:0,to:100,frames:24}]],
  ['Hero Title','Hero title cinematic zoom',[{edge:'in',property:'scaleX',from:1.18,to:1,frames:28},{edge:'in',property:'scaleY',from:1.18,to:1,frames:28},{edge:'in',property:'opacity',from:0,to:100,frames:28}]],
  ['Side Label','Side label enters from left',[{edge:'in',property:'positionX',from:-30,to:0,frames:12},{edge:'in',property:'opacity',from:0,to:100,frames:12}]],
  ['End Credits','Credits drift upward',[{edge:'in',property:'positionY',from:35,to:0,frames:28}]],
  ['Lower Third','Lower third rises with fade',[{edge:'in',property:'positionY',from:45,to:0,frames:18},{edge:'in',property:'opacity',from:0,to:100,frames:18}]],
  ['Badge Bounce','Badge scales into view',[{edge:'in',property:'scaleX',from:.5,to:1,frames:9},{edge:'in',property:'scaleY',from:.5,to:1,frames:9}]],
  ['Rotating Label','Label rotates into place',[{edge:'in',property:'rotation',from:12,to:0,frames:12},{edge:'in',property:'opacity',from:0,to:100,frames:12}]],
  ['Minimal Subtitle','Subtle subtitle fade',[{edge:'in',property:'opacity',from:0,to:100,frames:10}]],
  ['Title Retreat','Title scales away',[{edge:'out',property:'scaleX',from:1,to:.82,frames:20},{edge:'out',property:'scaleY',from:1,to:.82,frames:20},{edge:'out',property:'opacity',from:100,to:0,frames:20}]],
]

const styleSpecs: Array<[string,string,Partial<ClipEffects>]> = [
  ['Soft Glow Base','Soft, bright starting grade',{brightness:108,contrast:94,saturation:106,blur:.2}],
  ['Neon Night','Saturated neon palette',{contrast:132,saturation:145,hueRotate:205}],
  ['Dream Haze','Soft dreamy atmosphere',{brightness:112,contrast:82,saturation:112,blur:1.2}],
  ['Hard Edge','Crisp high-contrast style',{contrast:148,saturation:112}],
  ['Analog Warmth','Warm analog-inspired color',{sepia:18,contrast:94,saturation:108}],
  ['Cold Steel','Cool industrial look',{hueRotate:195,saturation:72,contrast:126}],
  ['Sun Bleach','Bright washed-out finish',{brightness:128,contrast:82,saturation:78}],
  ['Deep Shadow','Dark dramatic contrast',{brightness:78,contrast:145,saturation:108}],
  ['Muted Editorial','Restrained editorial palette',{saturation:70,contrast:104,brightness:102}],
  ['Candy Pop','Bright playful color',{saturation:155,contrast:110,brightness:105}],
  ['Mono Grain Base','Monochrome base for grain overlays',{grayscale:100,contrast:112}],
  ['Sepia Archive','Archival sepia tone',{sepia:48,grayscale:12,contrast:96}],
  ['Cyber Blue','Blue digital atmosphere',{hueRotate:215,saturation:135,contrast:124}],
  ['Rose Chrome','Pink metallic palette',{hueRotate:330,saturation:110,contrast:118}],
  ['Clean Minimal','Neutral modern finish',{brightness:104,contrast:100,saturation:94}],
  ['Moody Teal','Moody teal-inspired look',{hueRotate:188,saturation:118,contrast:132,brightness:92}],
  ['Golden Film','Golden warm film tone',{sepia:22,saturation:118,contrast:106}],
  ['Faded Summer','Soft summer fade',{brightness:112,contrast:86,saturation:88}],
  ['Urban Grit','Strong urban contrast',{contrast:150,saturation:92,brightness:96}],
  ['Dream Blue','Soft blue dreamy look',{hueRotate:200,brightness:110,contrast:88,saturation:90}],
]

export const CREATIVE_PRESETS: CreativePreset[] = [
  ...grades.map(([name,description,effects],index)=>({id:'grade-'+index,name,kind:'grade' as const,description,effects})),
  ...transitionSpecs.map(([name,description,motion],index)=>({id:'transition-'+index,name,kind:'transition' as const,description,motion})),
  ...motionSpecs.map(([name,description,motion],index)=>({id:'motion-'+index,name,kind:'motion' as const,description,motion})),
  ...styleSpecs.map(([name,description,effects],index)=>({id:'style-'+index,name,kind:'style' as const,description,effects})),
]

export const CREATIVE_ASSET_SOURCES = [
  {id:'daedal-luts',name:'DAEDAL Creative LUT collections',category:'LUTs',license:'CC0 1.0',url:'https://daedal.art/luts/',details:'Five Rec.709 LUT collections. Download from the source library.'},
  {id:'daedal-film',name:'DAEDAL film overlays and transitions',category:'Overlays',license:'CC0 1.0',url:'https://daedal.art/film-assets/',details:'Grain, light leaks, film burns, VHS, bokeh, particles and frames.'},
  {id:'google-fonts',name:'Google Fonts',category:'Fonts',license:'Per-family OFL / Apache / UFL',url:'https://fonts.google.com/',details:'Check the license attached to each family before bundling.'},
  {id:'ambientcg',name:'ambientCG materials and textures',category:'Textures',license:'CC0 1.0',url:'https://ambientcg.com/',details:'CC0 textures and HDRIs; suitable for graphic and 3D workflows.'},
  {id:'polyhaven',name:'Poly Haven',category:'3D / HDRI',license:'CC0 1.0',url:'https://polyhaven.com/',details:'CC0 HDRIs, textures and 3D assets.'},
] as const

export function validateCreativePresets(presets: CreativePreset[] = CREATIVE_PRESETS): boolean {
  const ids = new Set<string>()
  for (const preset of presets) {
    if (!preset.id || ids.has(preset.id) || !preset.name.trim()) return false
    ids.add(preset.id)
    for (const value of Object.values(preset.effects ?? {})) {
      if (typeof value === 'number' && !Number.isFinite(value)) return false
    }
    for (const motion of preset.motion ?? []) {
      if (![motion.from,motion.to,motion.frames].every(Number.isFinite) || motion.frames < 1) return false
    }
  }
  return true
}
