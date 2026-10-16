//! Serialize startup probes; failures are retryable after a short cooldown.
use std::sync::Mutex;
use std::time::{Duration, Instant};

type Outcome = Result<(), &'static str>;
#[derive(Default)]
pub(super) struct EngineReadiness {
    last: Mutex<Option<(Outcome, Instant)>>,
}
impl EngineReadiness {
    pub fn check(&self, probe: impl FnOnce() -> Outcome) -> Outcome {
        let mut last = self.last.lock().map_err(|_| "REMOTE_STATE_UNAVAILABLE")?;
        if let Some((result, finished)) = *last {
            if result.is_ok() || finished.elapsed() < Duration::from_secs(5) {
                return result;
            }
        }
        let result = probe();
        // Timestamp completion, so queued refreshes cannot immediately repeat a slow failure.
        *last = Some((result, Instant::now()));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transient_failure_retries_then_caches_success() {
        let cache = EngineReadiness::default();
        assert_eq!(
            cache.check(|| Err("REMOTE_ENGINE_PROBE_TIMEOUT")),
            Err("REMOTE_ENGINE_PROBE_TIMEOUT")
        );
        assert_eq!(
            cache.check(|| panic!("cooldown must coalesce refreshes")),
            Err("REMOTE_ENGINE_PROBE_TIMEOUT")
        );
        cache.last.lock().unwrap().as_mut().unwrap().1 = Instant::now() - Duration::from_secs(6);
        assert_eq!(cache.check(|| Ok(())), Ok(()));
        assert_eq!(
            cache.check(|| panic!("successful handshake remains cached")),
            Ok(())
        );
    }
    #[test]
    fn concurrent_refreshes_share_one_probe() {
        let cache = std::sync::Arc::new(EngineReadiness::default());
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                let count = count.clone();
                std::thread::spawn(move || {
                    cache.check(|| {
                        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Err("REMOTE_ENGINE_PROBE_REJECTED")
                    })
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), Err("REMOTE_ENGINE_PROBE_REJECTED"));
        }
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
