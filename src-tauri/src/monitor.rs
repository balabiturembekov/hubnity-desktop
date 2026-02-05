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
