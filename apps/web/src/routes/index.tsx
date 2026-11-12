import './home.css'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowUpRight, Clapperboard, Layers3, MonitorPlay, Sparkles, Workflow } from 'lucide-react'

export const Route = createFileRoute('/')({ component: Home })

const capabilities = [
  { icon: MonitorPlay, title: 'Video editing', description: 'A frame-aware multitrack editing foundation for video, audio and image media.' },
  { icon: Layers3, title: 'Compositing', description: 'A shared layer and composition model designed to grow into professional VFX.' },
  { icon: Workflow, title: 'Motion graphics', description: 'A foundation for keyframes, procedural animation and reusable graphics.' },
]

function Home() {
  return (
    <main className="kx-home">
      <header className="kx-home-nav">
        <a className="kx-home-brand" href="/"><span><Clapperboard size={18} /></span> KYROCUT <b>X1</b></a>
        <div className="kx-home-nav-right"><span>CREATIVE PRODUCTION SYSTEM</span><Link to="/editor" className="kx-home-open">Open editor <ArrowUpRight size={15} /></Link></div>
      </header>
      <section className="kx-hero">
        <div className="kx-hero-copy">
          <div className="kx-eyebrow"><i /> THE NEXT CREATIVE WORKSPACE</div>
          <h1>Make every frame<br /><em>mean something.</em></h1>
          <p>KYROCUT X1 is an ambitious creative production platform bringing video editing, compositing, motion graphics and 3D workflows into one connected workspace.</p>
          <div className="kx-hero-actions"><Link to="/editor" className="kx-launch"><Clapperboard size={17} /> Launch web editor <ArrowUpRight size={16} /></Link><span>WEB EDITION · FOUNDATION BUILD</span></div>
        </div>
        <div className="kx-hero-art" aria-label="KYROCUT X1 editor workspace illustration">
          <div className="kx-art-top"><span>KYROCUT / X1</span><span>COMPOSITION 01</span><span>30 FPS</span></div>
          <div className="kx-art-view"><div className="kx-art-frame"><div className="kx-art-orbit orbit-one" /><div className="kx-art-orbit orbit-two" /><div className="kx-art-core" /><span className="kx-art-cross cross-a" /><span className="kx-art-cross cross-b" /></div><div className="kx-art-view-label">LIVE COMPOSITION VIEW</div></div>
          <div className="kx-art-timeline"><div className="kx-art-ruler"><span>00:00</span><span>00:05</span><span>00:10</span><span>00:15</span><span>00:20</span></div><div className="kx-art-track"><i /><b>FOOTAGE_01.MOV</b></div><div className="kx-art-track second"><i /><b>ATMOSPHERE.wav</b></div><div className="kx-art-track third"><i /><b>GRAPHICS / LAYER 01</b></div></div>
          <div className="kx-art-corner">X1 / 001</div>
        </div>
      </section>
      <section className="kx-home-capabilities">
        <div className="kx-home-section-heading"><span>01 / PLATFORM FOUNDATION</span><h2>One workspace.<br />Multiple creative disciplines.</h2></div>
        <div className="kx-capability-grid">{capabilities.map(({ icon: Icon, title, description }, index) => <article className="kx-capability" key={title}><span className="kx-cap-index">0{index + 1}</span><Icon size={22} /><h3>{title}</h3><p>{description}</p></article>)}</div>
      </section>
      <footer className="kx-home-footer"><span>KYROCUT X1</span><span>BUILT FOR THE ENTIRE CREATIVE PIPELINE</span><span><Sparkles size={13} /> FOUNDATION BUILD</span></footer>
    </main>
  )
}
