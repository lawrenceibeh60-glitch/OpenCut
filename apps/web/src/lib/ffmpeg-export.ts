export type TranscodeProgress = (percent: number) => void

/** Transcode the editor's browser-recorded WebM stream into an MP4/H.264 + AAC file. */
export async function transcodeWebMToMp4(input: Blob, onProgress?: TranscodeProgress): Promise<Blob> {
  if (!input.size) throw new Error('The source recording is empty')
  const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/util'),
  ])
  const ffmpeg = new FFmpeg()
  const coreBase = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd'
  try {
    await ffmpeg.load({
      coreURL: await toBlobURL(coreBase + '/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL(coreBase + '/ffmpeg-core.wasm', 'application/wasm'),
    })
    ffmpeg.on('progress', ({ progress }) => onProgress?.(Math.max(0, Math.min(100, Math.round(progress * 100)))))
    await ffmpeg.writeFile('kyrocut-input.webm', new Uint8Array(await input.arrayBuffer()))
    await ffmpeg.exec([
      '-i', 'kyrocut-input.webm',
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      'kyrocut-output.mp4',
    ])
    const output = await ffmpeg.readFile('kyrocut-output.mp4')
    if (typeof output === 'string') throw new Error('FFmpeg returned text instead of an MP4 file')
    const mp4 = new Blob([new Uint8Array(output)], { type: 'video/mp4' })
    if (!mp4.size) throw new Error('FFmpeg produced an empty MP4 file')
    return mp4
  } finally {
    ffmpeg.terminate()
  }
}
