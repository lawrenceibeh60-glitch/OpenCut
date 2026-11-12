//! Frame-addressed scalar animation curves and interpolation.

use std::fmt;

use crate::Frame;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Interpolation {
    Hold,
    Linear,
    SmoothStep,
    CubicBezier {
        out_control: [f64; 2],
        in_control: [f64; 2],
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScalarKeyframe {
    pub frame: Frame,
    pub value: f64,
    /// Interpolation used from this keyframe to the next keyframe.
    pub interpolation: Interpolation,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScalarCurve {
    keyframes: Vec<ScalarKeyframe>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurveError {
    NonFiniteValue,
    NonIncreasingFrames,
    InvalidBezierHandles,
}

impl fmt::Display for CurveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteValue => write!(f, "keyframe values and Bezier handles must be finite"),
            Self::NonIncreasingFrames => write!(f, "keyframe frames must be strictly increasing"),
            Self::InvalidBezierHandles => write!(f, "Bezier x handles must satisfy 0 <= outgoing <= incoming <= 1"),
        }
    }
}

impl std::error::Error for CurveError {}

impl ScalarCurve {
    pub fn new(keyframes: Vec<ScalarKeyframe>) -> Result<Self, CurveError> {
        let curve = Self { keyframes };
        curve.validate()?;
        Ok(curve)
    }

    pub fn keyframes(&self) -> &[ScalarKeyframe] {
        &self.keyframes
    }

    pub fn validate(&self) -> Result<(), CurveError> {
        for (index, keyframe) in self.keyframes.iter().enumerate() {
            if !keyframe.value.is_finite() {
                return Err(CurveError::NonFiniteValue);
            }
            if index > 0 && self.keyframes[index - 1].frame >= keyframe.frame {
                return Err(CurveError::NonIncreasingFrames);
            }
            if let Interpolation::CubicBezier { out_control, in_control } = keyframe.interpolation {
                if out_control.iter().chain(in_control.iter()).any(|value| !value.is_finite()) {
                    return Err(CurveError::NonFiniteValue);
                }
                if !(0.0..=1.0).contains(&out_control[0])
                    || !(0.0..=1.0).contains(&in_control[0])
                    || out_control[0] > in_control[0]
                {
                    return Err(CurveError::InvalidBezierHandles);
                }
            }
        }
        Ok(())
    }

    pub fn evaluate(&self, frame: Frame) -> Option<f64> {
        let first = self.keyframes.first()?;
        let last = self.keyframes.last()?;
        if frame <= first.frame {
            return Some(first.value);
        }
        if frame >= last.frame {
            return Some(last.value);
        }

        for pair in self.keyframes.windows(2) {
            let left = pair[0];
            let right = pair[1];
            if frame == right.frame {
                return Some(right.value);
            }
            if frame >= left.frame && frame < right.frame {
                let span = right.frame.0 - left.frame.0;
                let progress = (frame.0 - left.frame.0) as f64 / span as f64;
                let amount = match left.interpolation {
                    Interpolation::Hold => 0.0,
                    Interpolation::Linear => progress,
                    Interpolation::SmoothStep => progress * progress * (3.0 - 2.0 * progress),
                    Interpolation::CubicBezier { out_control, in_control } => {
                        cubic_bezier_ease(progress, out_control, in_control)
                    }
                };
                return Some(left.value + (right.value - left.value) * amount);
            }
        }
        Some(last.value)
    }
}

fn cubic_bezier_ease(progress: f64, p1: [f64; 2], p2: [f64; 2]) -> f64 {
    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..28 {
        let t = (low + high) * 0.5;
        let x = cubic_component(t, p1[0], p2[0]);
        if x < progress {
            low = t;
        } else {
            high = t;
        }
    }
    cubic_component((low + high) * 0.5, p1[1], p2[1])
}

fn cubic_component(t: f64, p1: f64, p2: f64) -> f64 {
    let inverse = 1.0 - t;
    3.0 * inverse * inverse * t * p1
        + 3.0 * inverse * t * t * p2
        + t * t * t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(frame: u64, value: f64, interpolation: Interpolation) -> ScalarKeyframe {
        ScalarKeyframe { frame: Frame(frame), value, interpolation }
    }

    #[test]
    fn linear_curve_interpolates_between_keyframes() {
        let curve = ScalarCurve::new(vec![
            key(0, 0.0, Interpolation::Linear),
            key(30, 60.0, Interpolation::Linear),
        ]).unwrap();
        assert_eq!(curve.evaluate(Frame(15)), Some(30.0));
    }

    #[test]
    fn hold_curve_keeps_left_value_until_next_keyframe() {
        let curve = ScalarCurve::new(vec![
            key(0, 12.0, Interpolation::Hold),
            key(20, 48.0, Interpolation::Linear),
        ]).unwrap();
        assert_eq!(curve.evaluate(Frame(19)), Some(12.0));
        assert_eq!(curve.evaluate(Frame(20)), Some(48.0));
    }

    #[test]
    fn smoothstep_has_midpoint_and_clamped_endpoints() {
        let curve = ScalarCurve::new(vec![
            key(10, 0.0, Interpolation::SmoothStep),
            key(30, 1.0, Interpolation::Linear),
        ]).unwrap();
        assert_eq!(curve.evaluate(Frame(0)), Some(0.0));
        assert_eq!(curve.evaluate(Frame(20)), Some(0.5));
        assert_eq!(curve.evaluate(Frame(40)), Some(1.0));
    }

    #[test]
    fn cubic_bezier_curve_reaches_exact_endpoints() {
        let curve = ScalarCurve::new(vec![
            key(0, 0.0, Interpolation::CubicBezier {
                out_control: [0.2, 0.0], in_control: [0.8, 1.0],
            }),
            key(60, 100.0, Interpolation::Linear),
        ]).unwrap();
        assert_eq!(curve.evaluate(Frame(0)), Some(0.0));
        assert_eq!(curve.evaluate(Frame(60)), Some(100.0));
        let middle = curve.evaluate(Frame(30)).unwrap();
        assert!(middle > 45.0 && middle < 55.0);
    }

    #[test]
    fn rejects_duplicate_keyframe_positions() {
        let result = ScalarCurve::new(vec![
            key(10, 0.0, Interpolation::Linear),
            key(10, 1.0, Interpolation::Linear),
        ]);
        assert_eq!(result, Err(CurveError::NonIncreasingFrames));
    }

    #[test]
    fn rejects_non_monotonic_bezier_time_handles() {
        let result = ScalarCurve::new(vec![
            key(0, 0.0, Interpolation::CubicBezier {
                out_control: [0.9, 0.0], in_control: [0.2, 1.0],
            }),
            key(30, 1.0, Interpolation::Linear),
        ]);
        assert_eq!(result, Err(CurveError::InvalidBezierHandles));
    }
}
