//! Bounded, process-local stage timings. Nested stages overlap intentionally;
//! counts include errors and cancellations, and maxima are lifetime maxima.
use serde_json::{Value, json};
use std::{
    sync::atomic::{AtomicU64, Ordering::Relaxed},
    time::Instant,
};

#[derive(Clone, Copy)]
pub enum Stage {
    Pool,
    Selection,
    Peers,
    Policy,
    Discovery,
    Signing,
    Http,
    Finish,
    Delivery,
    InboxLane,
    InboxAuthentication,
    InboxActivityLock,
    InboxChannelLock,
    InboxTransaction,
    PoolBorrow,
    DeliveryBatch,
}
const NAMES: [&str; 16] = [
    "pool",
    "selection",
    "peers",
    "policy",
    "discovery",
    "signing",
    "http",
    "finish",
    "delivery",
    "inboxLane",
    "inboxAuthentication",
    "inboxActivityLock",
    "inboxChannelLock",
    "inboxTransaction",
    "poolBorrow",
    "deliveryBatch",
];
#[derive(Default)]
struct Stat {
    calls: AtomicU64,
    micros: AtomicU64,
    max_micros: AtomicU64,
}
#[derive(Default)]
pub struct Metrics {
    stats: [Stat; 16],
}
pub struct Timer<'a> {
    stat: &'a Stat,
    start: Instant,
}
impl Metrics {
    pub fn time(&self, stage: Stage) -> Timer<'_> {
        Timer {
            stat: &self.stats[stage as usize],
            start: Instant::now(),
        }
    }
    pub fn snapshot(&self) -> Value {
        Value::Object(
            NAMES
                .iter()
                .zip(&self.stats)
                .map(|(name, stat)| {
                    (
                        (*name).to_owned(),
                        json!({"calls":stat.calls.load(Relaxed),
                "totalMs":stat.micros.load(Relaxed) as f64 / 1000.0,
                "maxMs":stat.max_micros.load(Relaxed) as f64 / 1000.0}),
                    )
                })
                .collect(),
        )
    }
}
impl Drop for Timer<'_> {
    fn drop(&mut self) {
        let micros = self.start.elapsed().as_micros().min(u64::MAX as u128) as u64;
        self.stat.micros.fetch_add(micros, Relaxed);
        self.stat.max_micros.fetch_max(micros, Relaxed);
        self.stat.calls.fetch_add(1, Relaxed);
    }
}
