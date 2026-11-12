export type RationalFrameRate = {
  numerator: number
  denominator: number
}

export const SEQUENCE_FRAME_RATE: RationalFrameRate = {
  numerator: 30,
  denominator: 1,
}

function validateFrameRate(rate: RationalFrameRate): void {
  if (!Number.isInteger(rate.numerator) || !Number.isInteger(rate.denominator) || rate.numerator <= 0 || rate.denominator <= 0) {
    throw new RangeError('Frame-rate numerator and denominator must be positive integers')
  }
}

export function secondsToFrames(seconds: number, rate: RationalFrameRate = SEQUENCE_FRAME_RATE): number {
  validateFrameRate(rate)
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError('Time must be a finite, non-negative number of seconds')
  }
  const frames = Math.round(seconds * rate.numerator / rate.denominator)
  if (!Number.isSafeInteger(frames)) {
    throw new RangeError('Frame position exceeds the safe integer range')
  }
  return frames
}

export function framesToSeconds(frames: number, rate: RationalFrameRate = SEQUENCE_FRAME_RATE): number {
  validateFrameRate(rate)
  if (!Number.isSafeInteger(frames) || frames < 0) {
    throw new RangeError('Frame position must be a non-negative safe integer')
  }
  return frames * rate.denominator / rate.numerator
}
