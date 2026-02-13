use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct ActivityMonitor {
    pub is_monitoring: Arc<Mutex<bool>>,
    pub last_activity: Arc<Mutex<Instant>>,
}

impl ActivityMonitor {
    pub fn new() -> Self {
        Self {
            is_monitoring: Arc::new(Mutex::new(false)),
            last_activity: Arc::new(Mutex::new(Instant::now())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_activity_monitor_new() {
        let monitor = ActivityMonitor::new();
        assert!(!*monitor.is_monitoring.lock().unwrap());
        let last = *monitor.last_activity.lock().unwrap();
        assert!(last.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn test_activity_monitor_start_stop() {
        let monitor = ActivityMonitor::new();
        *monitor.is_monitoring.lock().unwrap() = true;
        assert!(*monitor.is_monitoring.lock().unwrap());
        *monitor.is_monitoring.lock().unwrap() = false;
        assert!(!*monitor.is_monitoring.lock().unwrap());
    }
}
