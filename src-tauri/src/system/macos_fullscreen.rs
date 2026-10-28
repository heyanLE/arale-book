//! Native fullscreen owns the Space, geometry, focus and system-bar presentation.
//! Observe AppKit completion without replacing Tao's window delegate.
use super::ImmersiveWindow;
use anyhow::{Context, Result};
use block2::RcBlock;
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{
    NSWindow, NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
    NSWindowWillCloseNotification, NSWindowWillEnterFullScreenNotification,
    NSWindowWillExitFullScreenNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue};
use std::{
    cell::RefCell,
    ptr::NonNull,
    sync::mpsc,
    time::Duration,
};
use tauri::Manager;

type Reply = mpsc::SyncSender<std::result::Result<(), String>>;
struct Pending {
    id: u64,
    target: bool,
    reply: Reply,
}

#[derive(Default)]
pub(super) struct Controller {
    next_id: u64,
    transition_id: u64,
    actual: bool,
    transitioning: bool,
    pending: Option<Pending>,
}

impl Controller {
    fn begin(&mut self, id: u64, target: bool, reply: Reply) -> bool {
        if self.transitioning || self.pending.is_some() {
            let _ = reply.send(Err("系统正在切换全屏，请稍后再试".into()));
            return false;
        }
        if self.actual == target {
            let _ = reply.send(Ok(()));
            return false;
        }
        self.pending = Some(Pending { id, target, reply });
        self.transitioning = true;
        true
    }

    /// Returns whether this completion matches an application request.
    fn finish(&mut self, actual: bool) -> bool {
        self.actual = actual;
        self.transitioning = false;
        if let Some(pending) = self.pending.take() {
            let matched = pending.target == actual;
            let _ = pending.reply.send(if matched {
                Ok(())
            } else {
                Err("系统中断了全屏切换".into())
            });
            matched
        } else {
            false
        }
    }

    fn fail(&mut self, id: u64, message: String) -> bool {
        if self.pending.as_ref().is_none_or(|pending| pending.id != id) {
            return false;
        }
        let pending = self.pending.take().unwrap();
        self.transitioning = false;
        let _ = pending.reply.send(Err(message));
        true
    }

    fn expire_external(&mut self, id: u64) -> bool {
        if self.transition_id != id || !self.transitioning || self.pending.is_some() {
            return false;
        }
        self.transitioning = false;
        true
    }
}

thread_local! {
    // AppKit observer tokens stay on the main thread and are removed on window close.
    static OBSERVERS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(Vec::new()) };
}

fn publish(app: &tauri::AppHandle, actual: bool, transitioning: bool, requested: bool) {
    crate::event(
        app,
        "window:fullscreenChanged",
        serde_json::json!({
            "fullscreen": actual, "transitioning": transitioning, "requested": requested,
        }),
    );
}

fn fail(app: &tauri::AppHandle, id: u64, message: String) {
    let mode = app.state::<ImmersiveWindow>();
    let mut state = mode.native.lock().unwrap();
    let changed = state.fail(id, message);
    let actual = state.actual;
    drop(state);
    if changed {
        publish(app, actual, false, false);
    }
}

pub(super) fn install(app: &tauri::AppHandle) -> Result<()> {
    let window = app.get_webview_window("main").context("主窗口不存在")?;
    let native = unsafe { &*window.ns_window()?.cast::<NSWindow>() };
    app.state::<ImmersiveWindow>().native.lock().unwrap().actual = window.is_fullscreen()?;
    let center = NSNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    let notifications = unsafe {
        [
            (NSWindowWillEnterFullScreenNotification, true, false),
            (NSWindowWillExitFullScreenNotification, false, false),
            (NSWindowDidEnterFullScreenNotification, true, true),
            (NSWindowDidExitFullScreenNotification, false, true),
        ]
    };
    for (name, enabled, completed) in notifications {
        let app = app.clone();
        let callback = RcBlock::new(move |_: NonNull<NSNotification>| {
            let mode = app.state::<ImmersiveWindow>();
            let mut state = mode.native.lock().unwrap();
            let requested = if completed {
                state.finish(enabled)
            } else {
                state.transition_id += 1;
                state.transitioning = true;
                state.pending.is_some()
            };
            let transition = state.transition_id;
            let (actual, transitioning) = (state.actual, state.transitioning);
            drop(state);
            publish(&app, actual, transitioning, requested);
            // AppKit reports failed native transitions to its delegate, which Tao
            // owns. A watchdog only clears a stuck UI; it never declares success.
            if !completed && !requested {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    let target = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        let mode = target.state::<ImmersiveWindow>();
                        let mut state = mode.native.lock().unwrap();
                        let expired = state.expire_external(transition);
                        let actual = state.actual;
                        drop(state);
                        if expired {
                            publish(&target, actual, false, false);
                        }
                    });
                });
            }
        });
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(native),
                Some(&queue),
                &callback,
            )
        };
        OBSERVERS.with(|tokens| tokens.borrow_mut().push(token));
    }
    let handle = app.clone();
    let close = RcBlock::new(move |_: NonNull<NSNotification>| {
        let mode = handle.state::<ImmersiveWindow>();
        let mut state = mode.native.lock().unwrap();
        if let Some(pending) = state.pending.take() {
            let _ = pending.reply.send(Err("窗口已关闭".into()));
        }
        drop(state);
        OBSERVERS.with(|tokens| {
            for token in tokens.borrow_mut().drain(..) {
                let observer: &objc2::runtime::AnyObject = (&*token).as_ref();
                unsafe {
                    NSNotificationCenter::defaultCenter().removeObserver(observer);
                }
            }
        });
    });
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillCloseNotification),
            Some(native),
            Some(&queue),
            &close,
        )
    };
    OBSERVERS.with(|tokens| tokens.borrow_mut().push(token));
    Ok(())
}

/// Runs on the IPC worker. The native main thread remains free to animate.
pub(super) fn set(app: &tauri::AppHandle, enabled: bool) -> Result<()> {
    let id = {
        let mode = app.state::<ImmersiveWindow>();
        let mut state = mode.native.lock().unwrap();
        state.next_id += 1;
        state.next_id
    };
    let (reply, receiver) = mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            let _ = reply.send(Err("主窗口不存在".into()));
            return;
        };
        let mode = handle.state::<ImmersiveWindow>();
        let mut state = mode.native.lock().unwrap();
        let started = state.begin(id, enabled, reply);
        let actual = state.actual;
        drop(state);
        if !started {
            return;
        }
        publish(&handle, actual, true, true);
        if let Err(error) = window.set_fullscreen(enabled) {
            fail(&handle, id, error.to_string());
        }
    })?;
    match receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(result) => result.map_err(anyhow::Error::msg),
        Err(_) => {
            let handle = app.clone();
            let _ = app
                .run_on_main_thread(move || fail(&handle, id, "系统全屏切换超时，请重试".into()));
            anyhow::bail!("系统全屏切换超时，请重试")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_complete_only_after_native_confirmation() {
        let mut state = Controller::default();
        let (reply, receiver) = mpsc::sync_channel(1);
        assert!(state.begin(1, true, reply));
        assert!(receiver.try_recv().is_err());
        assert!(!state.actual);
        assert!(state.finish(true));
        assert!(receiver.recv().unwrap().is_ok());
        assert!(state.actual && !state.transitioning);
        assert!(!state.finish(false)); // Escape/green button is a system-origin exit.
        assert!(!state.actual);
    }
    #[test]
    fn repeated_requests_and_stale_failures_do_not_override_transitions() {
        let mut state = Controller::default();
        let (reply, receiver) = mpsc::sync_channel(1);
        assert!(!state.begin(1, false, reply));
        assert!(receiver.recv().unwrap().is_ok());
        let (reply, first) = mpsc::sync_channel(1);
        assert!(state.begin(2, true, reply));
        let (reply, second) = mpsc::sync_channel(1);
        assert!(!state.begin(3, false, reply));
        assert!(second.recv().unwrap().is_err());
        assert!(!state.fail(1, "stale timeout".into()));
        assert!(state.fail(2, "cancelled".into()));
        assert!(first.recv().unwrap().is_err());
        assert!(!state.actual && !state.transitioning);
        let (reply, receiver) = mpsc::sync_channel(1);
        assert!(state.begin(4, true, reply));
        assert!(!state.finish(false));
        assert!(receiver.recv().unwrap().is_err());
    }
    #[test]
    fn external_transition_timeout_is_not_a_completion_signal() {
        let mut state = Controller {
            transition_id: 2,
            transitioning: true,
            ..Default::default()
        };
        assert!(!state.expire_external(1));
        assert!(state.expire_external(2));
        assert!(!state.actual);
        assert!(!state.transitioning);
        assert!(!state.finish(true)); // A late system confirmation is still accepted.
        assert!(state.actual);
    }
}
