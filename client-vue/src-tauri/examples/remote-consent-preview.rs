//! Offline native visual preview; never grants real remote access.
//! cargo run --example remote-consent-preview --features remote-control-harness
#[cfg(all(target_os = "macos", feature = "remote-control-harness"))]
mod identity {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Decision {
        View,
        Control,
        Reject,
    }
}
#[cfg(all(target_os = "macos", feature = "remote-control-harness"))]
#[allow(dead_code)]
#[path = "../src/remote_control/consent_dialog.rs"]
mod consent_dialog;

#[cfg(all(target_os = "macos", feature = "remote-control-harness"))]
fn main() {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow,
        NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.finishLaunching();
    let parent = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1000.0, 640.0)),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { parent.setReleasedWhenClosed(false) };
    parent.setTitle(&NSString::from_str(
        "NearLink · 离线授权弹窗预览（不会发起远控）",
    ));
    parent.center();
    parent.makeKeyAndOrderFront(None);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    let timeout = if std::env::args().any(|a| a == "--expire") {
        2
    } else {
        45
    };
    let result = consent_dialog::preview(
        mtm,
        &parent,
        consent_dialog::Prompt {
            controller_account: 10001,
            details: "离线测试请求；没有真实设备、凭证或授权。".into(),
            control: !std::env::args().any(|a| a == "--view"),
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(timeout),
        },
    );
    println!("Offline preview result: {result:?}");
    parent.orderOut(None);
}
#[cfg(not(all(target_os = "macos", feature = "remote-control-harness")))]
fn main() {
    eprintln!("Requires macOS and --features remote-control-harness");
}
