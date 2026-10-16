//! Capture, encode, transport and presentation progress are independent. Receipt
//! of a queued IPC event never refreshes the event's original monotonic time.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};

pub(super) const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
const END_AFTER: Duration = Duration::from_secs(10);
type ProgressResult<T> = Result<T, &'static str>;

#[derive(Clone, Copy, Debug, Default)]
struct StageProgress {
    seq: u64,
    ns: u64,
    at: Option<Instant>,
}
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct NativeMediaProgress {
    stages: [StageProgress; 3],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProgressPayload {
    capture_seq: u64,
    capture_monotonic_ns: String,
    encoded_seq: u64,
    encoded_monotonic_ns: String,
    forwarded_seq: u64,
    forwarded_monotonic_ns: String,
}
impl NativeMediaProgress {
    /// Called only by the MAC-authenticated child pipe reader. The caller samples
    /// Instant BEFORE CLOCK_MONOTONIC, making the conversion conservative.
    pub fn observe(
        &mut self,
        payload: Value,
        clock_ns: u64,
        sampled_at: Instant,
    ) -> ProgressResult<()> {
        let payload: ProgressPayload =
            serde_json::from_value(payload).map_err(|_| "REMOTE_MEDIA_PROGRESS_INVALID")?;
        let mut next = *self;
        for (stage, (seq, ns)) in next.stages.iter_mut().zip([
            (payload.capture_seq, payload.capture_monotonic_ns),
            (payload.encoded_seq, payload.encoded_monotonic_ns),
            (payload.forwarded_seq, payload.forwarded_monotonic_ns),
        ]) {
            if ns.is_empty()
                || ns.len() > 20
                || !ns.bytes().all(|b| b.is_ascii_digit())
                || (ns.len() > 1 && ns.starts_with('0'))
            {
                return Err("REMOTE_MEDIA_PROGRESS_INVALID");
            }
            let ns: u64 = ns.parse().map_err(|_| "REMOTE_MEDIA_PROGRESS_INVALID")?;
            if seq > MAX_SEQUENCE
                || (seq == 0) != (ns == 0)
                || ns > clock_ns
                || seq < stage.seq
                || (seq == stage.seq && ns != stage.ns)
                || (seq > stage.seq && ns <= stage.ns)
            {
                return Err("REMOTE_MEDIA_PROGRESS_INVALID");
            }
            if seq > stage.seq {
                stage.at = Some(
                    sampled_at
                        .checked_sub(Duration::from_nanos(clock_ns - ns))
                        .ok_or("REMOTE_MEDIA_PROGRESS_INVALID")?,
                );
                stage.seq = seq;
                stage.ns = ns;
            }
        }
        *self = next;
        Ok(())
    }
    #[cfg(test)]
    pub fn at(seq: u64, at: Instant) -> Self {
        Self {
            stages: [StageProgress {
                seq,
                ns: seq,
                at: Some(at),
            }; 3],
        }
    }
    #[cfg(test)]
    pub fn set_stage(&mut self, stage: usize, seq: u64, at: Instant) {
        self.stages[stage] = StageProgress {
            seq,
            ns: seq,
            at: Some(at),
        };
    }
}

/// The child and parent explicitly use the same kernel clock; unsupported
/// platforms fail closed instead of guessing how their monotonic clocks align.
#[cfg(unix)]
pub(super) fn clock_sample() -> ProgressResult<(u64, Instant)> {
    let at = Instant::now();
    let mut clock = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut clock) } != 0
        || clock.tv_sec < 0
        || !(0..1_000_000_000).contains(&clock.tv_nsec)
    {
        return Err("REMOTE_MEDIA_CLOCK_UNAVAILABLE");
    }
    let ns = (clock.tv_sec as u64)
        .checked_mul(1_000_000_000)
        .and_then(|value| value.checked_add(clock.tv_nsec as u64))
        .ok_or("REMOTE_MEDIA_CLOCK_UNAVAILABLE")?;
    Ok((ns, at))
}
#[cfg(target_os = "windows")]
pub(super) fn clock_sample() -> ProgressResult<(u64, Instant)> {
    use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let at = Instant::now();
    let (mut counter, mut frequency) = (0, 0);
    if unsafe { QueryPerformanceCounter(&mut counter) } == 0
        || unsafe { QueryPerformanceFrequency(&mut frequency) } == 0
        || counter < 0 || frequency <= 0 {
        return Err("REMOTE_MEDIA_CLOCK_UNAVAILABLE");
    }
    let ns = (counter as u128 * 1_000_000_000 / frequency as u128)
        .try_into().map_err(|_| "REMOTE_MEDIA_CLOCK_UNAVAILABLE")?;
    Ok((ns, at))
}
#[cfg(not(any(unix, target_os = "windows")))]
pub(super) fn clock_sample() -> ProgressResult<(u64, Instant)> {
    Err("REMOTE_MEDIA_CLOCK_UNAVAILABLE")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum MediaStatus {
    Waiting,
    Healthy,
    Frozen,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum MediaStage {
    Capture,
    Encoded,
    Forwarded,
    Rendered,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(super) struct MediaHealth {
    pub status: MediaStatus,
    pub stage: Option<MediaStage>,
}
impl Default for MediaHealth {
    fn default() -> Self {
        Self {
            status: MediaStatus::Waiting,
            stage: None,
        }
    }
}
#[derive(Default)]
pub(super) struct MediaLiveness {
    started: Option<Instant>,
    baseline: NativeMediaProgress,
    rendered_seq: u64,
    rendered_at: Option<Instant>,
}
impl MediaLiveness {
    pub fn start(&mut self, now: Instant, baseline: NativeMediaProgress) -> ProgressResult<()> {
        if self.started.is_some() {
            return Err("REMOTE_MEDIA_RESTART_REJECTED");
        }
        self.started = Some(now);
        self.baseline = baseline;
        Ok(())
    }
    pub fn rendered(&mut self, frames: u64, now: Instant) -> ProgressResult<()> {
        if frames > MAX_SEQUENCE
            || frames < self.rendered_seq
            || (frames > 0 && self.started.is_none())
        {
            return Err("REMOTE_RENDER_PROGRESS_INVALID");
        }
        if frames > self.rendered_seq {
            self.rendered_seq = frames;
            self.rendered_at = Some(now);
        }
        Ok(())
    }
    fn progress(&self, native: NativeMediaProgress) -> Option<[(MediaStage, Option<Instant>); 4]> {
        let started = self.started?;
        let stages = [
            MediaStage::Capture,
            MediaStage::Encoded,
            MediaStage::Forwarded,
        ];
        let mut result = [(MediaStage::Rendered, None); 4];
        for i in 0..3 {
            result[i] = (
                stages[i],
                native.stages[i].at.filter(|at| {
                    native.stages[i].seq > self.baseline.stages[i].seq && *at >= started
                }),
            );
        }
        result[3] = (
            MediaStage::Rendered,
            self.rendered_at.filter(|at| *at >= started),
        );
        Some(result)
    }
    pub fn health(&self, native: NativeMediaProgress, now: Instant) -> MediaHealth {
        let Some(progress) = self.progress(native) else {
            return MediaHealth::default();
        };
        let started = self.started.unwrap();
        let (stage, oldest) = progress
            .iter()
            .map(|(stage, at)| (*stage, at.unwrap_or(started)))
            .min_by_key(|(_, at)| *at)
            .unwrap();
        let age = now.saturating_duration_since(oldest);
        // Startup delays and short stalls must not revoke the approved control epoch.
        // The viewer may release input locally; only sustained loss ends the session.
        let status = if age >= END_AFTER {
            MediaStatus::Frozen
        } else if progress
            .iter()
            .any(|(_, at)| at.is_none() || at.is_some_and(|at| at > now))
        {
            MediaStatus::Waiting
        } else {
            MediaStatus::Healthy
        };
        let stage = if status == MediaStatus::Waiting {
            progress
                .iter()
                .find(|(_, at)| at.is_none())
                .map(|(stage, _)| *stage)
                .or(Some(stage))
        } else if status == MediaStatus::Healthy {
            return MediaHealth {
                status,
                stage: None,
            };
        } else {
            Some(stage)
        };
        MediaHealth { status, stage }
    }
    pub fn input_deadline(&self, native: NativeMediaProgress, now: Instant) -> Option<Instant> {
        if self.health(native, now).status != MediaStatus::Healthy {
            return None;
        }
        self.progress(native)?
            .iter()
            .map(|(_, at)| at.and_then(|at| at.checked_add(END_AFTER)))
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn payload(seq: u64, ns: u64) -> Value {
        json!({"captureSeq":seq,"captureMonotonicNs":ns.to_string(),"encodedSeq":seq,"encodedMonotonicNs":ns.to_string(),"forwardedSeq":seq,"forwardedMonotonicNs":ns.to_string()})
    }
    #[test]
    fn malformed_regressed_or_future_progress_is_rejected_atomically() {
        let now = Instant::now();
        let mut p = NativeMediaProgress::default();
        p.observe(payload(1, 1_000_000_000), 2_000_000_000, now)
            .unwrap();
        for value in [
            payload(0, 0),
            payload(1, 1_000_000_001),
            payload(2, 1_000_000_000),
            payload(2, 2_000_000_001),
            payload(MAX_SEQUENCE + 1, 1_000_000_001),
            payload(0, 1),
        ] {
            assert!(p.observe(value, 2_000_000_000, now).is_err());
            assert_eq!(p.stages[0].seq, 1);
        }
        for (key, value) in [
            ("extra", json!(true)),
            ("encodedSeq", json!(-1)),
            ("encodedSeq", json!(1.0)),
            ("encodedMonotonicNs", json!("01")),
            ("encodedMonotonicNs", json!("18446744073709551616")),
        ] {
            let mut invalid = payload(2, 1_500_000_000);
            invalid[key] = value;
            assert!(p.observe(invalid, 2_000_000_000, now).is_err());
            assert_eq!(p.stages[0].seq, 1);
        }
    }
    #[test]
    fn unchanged_and_queued_events_keep_the_original_instant() {
        let now = Instant::now();
        let mut p = NativeMediaProgress::default();
        p.observe(payload(1, 1_000_000_000), 2_000_000_000, now)
            .unwrap();
        let at = p.stages[0].at;
        p.observe(
            payload(1, 1_000_000_000),
            5_000_000_000,
            now + Duration::from_secs(3),
        )
        .unwrap();
        assert_eq!(p.stages[0].at, at);
        p.observe(
            payload(2, 2_000_000_000),
            9_000_000_000,
            now + Duration::from_secs(7),
        )
        .unwrap();
        assert_eq!(p.stages[0].at, Some(now));
    }
    #[test]
    fn first_frame_wait_does_not_revoke_control_at_three_seconds() {
        for stage in 0..4 {
            let now = Instant::now();
            let mut live = MediaLiveness::default();
            live.start(now, NativeMediaProgress::default()).unwrap();
            let mut native = NativeMediaProgress::at(1, now);
            if stage < 3 {
                native.stages[stage] = StageProgress::default();
            } else {
                live.rendered(0, now).unwrap();
            }
            if stage != 3 {
                live.rendered(1, now).unwrap();
            }
            assert_eq!(live.health(native, now).status, MediaStatus::Waiting);
            assert!(live.input_deadline(native, now).is_none());
            assert_eq!(
                live.health(native, now + Duration::from_secs(3)).status,
                MediaStatus::Waiting
            );
            assert_eq!(
                live.health(native, now + END_AFTER).status,
                MediaStatus::Frozen
            );
        }
    }
    #[test]
    fn one_frozen_stage_cannot_be_hidden_by_other_progress() {
        let now = Instant::now();
        let mut live = MediaLiveness::default();
        live.start(now, NativeMediaProgress::default()).unwrap();
        live.rendered(1, now).unwrap();
        let mut native = NativeMediaProgress::at(1, now);
        assert_eq!(live.health(native, now).status, MediaStatus::Healthy);
        for seconds in 1..=10 {
            let at = now + Duration::from_secs(seconds);
            native.set_stage(1, seconds + 1, at);
            native.set_stage(2, seconds + 1, at);
            live.rendered(seconds + 1, at).unwrap();
            let health = live.health(native, at);
            if seconds >= 10 {
                assert_eq!(health.stage, Some(MediaStage::Capture));
                assert_eq!(health.status, MediaStatus::Frozen);
            } else {
                assert_eq!(health.status, MediaStatus::Healthy);
            }
        }
    }
    #[test]
    fn browser_counter_duplicates_do_not_refresh_and_regression_is_rejected() {
        let now = Instant::now();
        let mut live = MediaLiveness::default();
        assert!(live.rendered(1, now).is_err());
        live.start(now, NativeMediaProgress::default()).unwrap();
        live.rendered(1, now).unwrap();
        live.rendered(1, now + END_AFTER).unwrap();
        assert!(live.rendered(0, now + END_AFTER).is_err());
        let native = NativeMediaProgress::at(2, now + END_AFTER);
        assert_eq!(
            live.health(native, now + END_AFTER),
            MediaHealth {
                status: MediaStatus::Frozen,
                stage: Some(MediaStage::Rendered)
            }
        );
        assert!(live.start(now + END_AFTER, native).is_err());
    }
}
