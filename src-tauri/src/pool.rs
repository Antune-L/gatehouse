//! Connection pools, keyed by (profile, database, target fingerprint)
//! (Decisions §10 "Ressources agent": 2 worker connections per target, 15 s
//! wait queue, never a silent reconnection — a connection in an uncertain
//! state is destroyed and recreated with the full session ritual).
//!
//! Keys start with `<profile_id>|`: when a profile's target changes (edit,
//! tunnel re-established on a new port), checkout purges the idle connections
//! recorded under the profile's stale keys.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub const MAX_PER_KEY: usize = 2;
pub const WAIT: Duration = Duration::from_secs(15);

struct Slot<C> {
    idle: Vec<C>,
    in_use: usize,
}

impl<C> Default for Slot<C> {
    fn default() -> Self {
        Self {
            idle: Vec::new(),
            in_use: 0,
        }
    }
}

pub struct Pool<C> {
    slots: Mutex<HashMap<String, Slot<C>>>,
    cond: Condvar,
}

impl<C> Default for Pool<C> {
    fn default() -> Self {
        Self {
            slots: Mutex::default(),
            cond: Condvar::new(),
        }
    }
}

pub struct Lease<'a, C> {
    pool: &'a Pool<C>,
    key: String,
    conn: Option<C>,
}

impl<C> Lease<'_, C> {
    pub fn conn(&mut self) -> &mut C {
        self.conn.as_mut().expect("lease already destroyed")
    }

    /// Drop the connection instead of returning it to the pool — mandatory
    /// after any error (uncertain state is never reused).
    pub fn destroy(mut self) {
        self.conn = None;
    }
}

impl<C> Drop for Lease<'_, C> {
    fn drop(&mut self) {
        let mut slots = self.pool.slots.lock().unwrap();
        if let Some(slot) = slots.get_mut(&self.key) {
            slot.in_use = slot.in_use.saturating_sub(1);
            if let Some(conn) = self.conn.take() {
                slot.idle.push(conn);
            }
        }
        self.pool.cond.notify_one();
    }
}

impl<C> Pool<C> {
    /// Check out a connection for `key`: reuse a probed-healthy idle one,
    /// create one if under the cap, otherwise wait for a slot (bounded).
    pub fn checkout<E>(
        &self,
        key: &str,
        create: impl Fn() -> Result<C, E>,
        probe: impl Fn(&mut C) -> bool,
        timeout_err: impl Fn() -> E,
    ) -> Result<Lease<'_, C>, E> {
        self.purge_stale_keys(key);
        let deadline = Instant::now() + WAIT;
        let mut slots = self.slots.lock().unwrap();
        loop {
            let slot = slots.entry(key.to_string()).or_default();
            if let Some(mut conn) = slot.idle.pop() {
                slot.in_use += 1;
                drop(slots);
                if probe(&mut conn) {
                    return Ok(self.lease(key, conn));
                }
                drop(conn);
                return self.create_in_reserved_slot(key, create);
            }
            if slot.in_use < MAX_PER_KEY {
                slot.in_use += 1;
                drop(slots);
                return self.create_in_reserved_slot(key, create);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(timeout_err());
            }
            let (guard, _) = self.cond.wait_timeout(slots, deadline - now).unwrap();
            slots = guard;
        }
    }

    fn lease(&self, key: &str, conn: C) -> Lease<'_, C> {
        Lease {
            pool: self,
            key: key.to_string(),
            conn: Some(conn),
        }
    }

    /// The caller already incremented `in_use`; release the slot on failure.
    fn create_in_reserved_slot<E>(
        &self,
        key: &str,
        create: impl Fn() -> Result<C, E>,
    ) -> Result<Lease<'_, C>, E> {
        match create() {
            Ok(conn) => Ok(self.lease(key, conn)),
            Err(e) => {
                let mut slots = self.slots.lock().unwrap();
                if let Some(slot) = slots.get_mut(key) {
                    slot.in_use = slot.in_use.saturating_sub(1);
                }
                self.cond.notify_one();
                Err(e)
            }
        }
    }

    /// Drop idle connections recorded under the same profile prefix but a
    /// different key (edited profile, re-established tunnel).
    fn purge_stale_keys(&self, current_key: &str) {
        let Some(prefix_len) = current_key.find('|') else {
            return;
        };
        let prefix = &current_key[..=prefix_len];
        let mut slots = self.slots.lock().unwrap();
        slots.retain(|k, slot| {
            if k == current_key || !k.starts_with(prefix) {
                return true;
            }
            slot.idle.clear();
            slot.in_use > 0
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct FakeConn {
        healthy: bool,
    }

    fn pool() -> Pool<FakeConn> {
        Pool::default()
    }

    #[test]
    fn reuses_idle_connections() {
        let p = pool();
        let created = AtomicUsize::new(0);
        let create = || {
            created.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(FakeConn { healthy: true })
        };
        drop(
            p.checkout("p1|db", create, |c| c.healthy, || "t".into())
                .unwrap(),
        );
        drop(
            p.checkout("p1|db", create, |c| c.healthy, || "t".into())
                .unwrap(),
        );
        assert_eq!(created.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn destroyed_connections_are_not_reused() {
        let p = pool();
        let created = AtomicUsize::new(0);
        let create = || {
            created.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(FakeConn { healthy: true })
        };
        p.checkout("p1|db", create, |c| c.healthy, || "t".into())
            .unwrap()
            .destroy();
        drop(
            p.checkout("p1|db", create, |c| c.healthy, || "t".into())
                .unwrap(),
        );
        assert_eq!(created.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn failed_probe_replaces_the_connection() {
        let p = pool();
        let created = AtomicUsize::new(0);
        let create = || {
            created.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(FakeConn { healthy: false })
        };
        drop(
            p.checkout("p1|db", create, |c| c.healthy, || "t".into())
                .unwrap(),
        );
        drop(
            p.checkout("p1|db", create, |c| c.healthy, || "t".into())
                .unwrap(),
        );
        // Second checkout probed the idle unhealthy conn and created a fresh one.
        assert_eq!(created.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn cap_blocks_third_concurrent_checkout_until_release() {
        let p = Arc::new(pool());
        let create = || Ok::<_, String>(FakeConn { healthy: true });
        let l1 = p
            .checkout("p1|db", create, |c| c.healthy, || "t".into())
            .unwrap();
        let l2 = p
            .checkout("p1|db", create, |c| c.healthy, || "t".into())
            .unwrap();

        let p2 = p.clone();
        let waiter = std::thread::spawn(move || {
            p2.checkout(
                "p1|db",
                || Ok::<_, String>(FakeConn { healthy: true }),
                |c| c.healthy,
                || "timeout".to_string(),
            )
            .map(|_| ())
        });
        std::thread::sleep(Duration::from_millis(50));
        drop(l1);
        assert!(waiter.join().unwrap().is_ok());
        drop(l2);
    }

    #[test]
    fn create_failure_releases_the_slot() {
        let p = pool();
        let attempts = AtomicUsize::new(0);
        let create = || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err::<FakeConn, String>("boom".into())
        };
        assert!(p
            .checkout("p1|db", create, |c| c.healthy, || "t".into())
            .is_err());
        assert!(p
            .checkout("p1|db", create, |c| c.healthy, || "t".into())
            .is_err());
        // Both attempts got a slot — a leaked reservation would starve here.
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stale_profile_keys_are_purged() {
        let p = pool();
        let create = || Ok::<_, String>(FakeConn { healthy: true });
        drop(
            p.checkout("p1|old", create, |c| c.healthy, || "t".into())
                .unwrap(),
        );
        drop(
            p.checkout("p2|db", create, |c| c.healthy, || "t".into())
                .unwrap(),
        );
        drop(
            p.checkout("p1|new", create, |c| c.healthy, || "t".into())
                .unwrap(),
        );
        let slots = p.slots.lock().unwrap();
        assert!(!slots.contains_key("p1|old"));
        assert!(slots.contains_key("p2|db"));
    }
}
