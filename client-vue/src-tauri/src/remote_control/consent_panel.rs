//! AppKit-only consent surface. No web content, invoke, or IPC can select a result.
use super::{choice, Choice, Prompt};
use objc2::{define_class, msg_send, rc::Retained, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSBox, NSBoxType, NSButton, NSColor, NSFont,
    NSModalPanelRunLoopMode, NSPanel, NSTextAlignment, NSTextField, NSTitlePosition, NSView,
    NSWindow, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSRunLoop, NSSize, NSString, NSTimer};

const WIDTH: f64 = 700.0;
const HEIGHT: f64 = 456.0;

// Native target/action and responder handling are the only paths to a decision.
define_class!(
    #[unsafe(super(NSPanel, NSWindow, objc2_app_kit::NSResponder, objc2_foundation::NSObject))]
    #[name = "ToDeskNativeConsentPanel"]
    #[thread_kind = MainThreadOnly]
    struct ConsentPanel;
    impl ConsentPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool { true }

        #[unsafe(method(selectConsent:))]
        fn select_consent(&self, sender: &NSButton) {
            NSApplication::sharedApplication(self.mtm()).stopModalWithCode(sender.tag());
        }

        #[unsafe(method(cancelOperation:))]
        fn cancel(&self, _sender: Option<&objc2::runtime::AnyObject>) {
            NSApplication::sharedApplication(self.mtm()).stopModalWithCode(1000);
        }

        #[unsafe(method(performClose:))]
        fn dismiss(&self, _sender: Option<&objc2::runtime::AnyObject>) {
            NSApplication::sharedApplication(self.mtm()).stopModalWithCode(1000);
        }
    }
);

fn rect(x: f64, top: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(
        NSPoint::new(x, HEIGHT - top - height),
        NSSize::new(width, height),
    )
}
fn color(hex: u32) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(
        ((hex >> 16) & 255) as f64 / 255.0,
        ((hex >> 8) & 255) as f64 / 255.0,
        (hex & 255) as f64 / 255.0,
        1.0,
    )
}
fn label(mtm: MainThreadMarker, root: &NSView, text: &str, frame: NSRect, size: f64, ink: u32) {
    let view = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    view.setFrame(frame);
    view.setFont(Some(&NSFont::systemFontOfSize(size)));
    view.setTextColor(Some(&color(ink)));
    view.setMaximumNumberOfLines(1);
    root.addSubview(&view);
}
fn surface(
    mtm: MainThreadMarker,
    root: &NSView,
    frame: NSRect,
    fill: u32,
    radius: f64,
    border: bool,
) {
    let view = NSBox::initWithFrame(NSBox::alloc(mtm), frame);
    view.setBoxType(NSBoxType::Custom);
    view.setTitlePosition(NSTitlePosition::NoTitle);
    view.setCornerRadius(radius);
    view.setBorderWidth(if border { 1.0 } else { 0.0 });
    view.setBorderColor(&color(0xE0E6EF));
    view.setFillColor(&color(fill));
    root.addSubview(&view);
}
fn button(
    mtm: MainThreadMarker,
    root: &NSView,
    panel: &ConsentPanel,
    title: &str,
    frame: NSRect,
    tag: isize,
    fill: u32,
    ink: u32,
) -> Retained<NSButton> {
    surface(mtm, root, frame, fill, 8.0, false);
    // The target is retained by show() for the entire modal session.
    let button = unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(title),
            Some(panel),
            Some(sel!(selectConsent:)),
            mtm,
        )
    };
    button.setFrame(frame);
    button.setBordered(false);
    button.setFont(Some(&NSFont::systemFontOfSize(16.0)));
    button.setContentTintColor(Some(&color(ink)));
    button.setAlignment(NSTextAlignment::Left);
    button.setTag(tag);
    // Inset text without changing the button's hit target; the native title
    // remains available to accessibility and keyboard navigation.
    button.setTitle(&NSString::from_str(&format!("   {title}")));
    root.addSubview(&button);
    button
}

pub(super) fn show(mtm: MainThreadMarker, parent: &NSWindow, prompt: Prompt) -> Choice {
    let remaining = prompt
        .deadline
        .saturating_duration_since(std::time::Instant::now());
    if remaining.is_zero() {
        return choice(1000, prompt.control, false);
    }
    let panel: Retained<ConsentPanel> = unsafe {
        msg_send![ConsentPanel::alloc(mtm),
            initWithContentRect: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(WIDTH, HEIGHT)),
            styleMask: NSWindowStyleMask::Borderless,
            backing: NSBackingStoreType::Buffered,
            defer: false]
    };
    // The Retained owner, not AppKit's close handling, owns this window.
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setTitle(&NSString::from_str("NearLink · 本机远程协助确认"));
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHasShadow(true);
    let root = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, WIDTH, HEIGHT));
    panel.setContentView(Some(&root));
    surface(
        mtm,
        &root,
        rect(0.0, 0.0, WIDTH, HEIGHT),
        0xFFFFFF,
        16.0,
        true,
    );
    let action = if prompt.control { "控制" } else { "查看" };
    // The current signed protocol provides an account ID, not a verified
    // nickname. Never substitute a web-supplied name into trusted consent UI.
    label(
        mtm,
        &root,
        &format!("账号 {} 希望{action}这台电脑", prompt.controller_account),
        rect(34.0, 27.0, 632.0, 40.0),
        26.0,
        0x273246,
    );
    label(
        mtm,
        &root,
        &format!(
            "设备：本机    范围：{}",
            if prompt.control {
                "屏幕与键盘鼠标"
            } else {
                "仅屏幕"
            }
        ),
        rect(34.0, 86.0, 632.0, 26.0),
        17.0,
        0x354157,
    );
    surface(
        mtm,
        &root,
        rect(34.0, 142.0, 632.0, 92.0),
        0xF0F6FF,
        12.0,
        false,
    );
    label(
        mtm,
        &root,
        if prompt.control {
            "允许控制后，对方可以操作当前桌面上的应用。"
        } else {
            "允许查看后，对方可以看到当前屏幕，但不能操作。"
        },
        rect(54.0, 158.0, 594.0, 26.0),
        17.0,
        0x354157,
    );
    label(
        mtm,
        &root,
        "可随时在本机结束协助。",
        rect(54.0, 196.0, 594.0, 24.0),
        15.0,
        0x7789A4,
    );
    let checkbox = unsafe {
        NSButton::checkboxWithTitle_target_action(
            &NSString::from_str("不再提示：记住对此账号的允许范围"),
            None,
            None,
            mtm,
        )
    };
    checkbox.setFrame(rect(34.0, 267.0, 632.0, 28.0));
    checkbox.setFont(Some(&NSFont::systemFontOfSize(17.0)));
    checkbox.setContentTintColor(Some(&color(0x354157)));
    checkbox.setState(0);
    root.addSubview(&checkbox);
    label(
        mtm,
        &root,
        "可在本机协助设置恢复每次确认；该操作不会结束当前会话。",
        rect(34.0, 307.0, 632.0, 24.0),
        13.0,
        0x7789A4,
    );
    // Full signed identity/session details remain inspectable without crowding
    // the primary layout. No account/device/session information is fabricated.
    root.setToolTip(Some(&NSString::from_str(&prompt.details)));
    let reject = button(
        mtm,
        &root,
        &panel,
        "拒绝",
        rect(34.0, 373.0, 139.0, 42.0),
        1000,
        0xFFF4F4,
        0xEB3030,
    );
    // Return intentionally rejects; neither Return nor Escape grants consent.
    reject.setKeyEquivalent(&NSString::from_str("\r"));
    let view_width = if prompt.control { 224.0 } else { 478.0 };
    let view = button(
        mtm,
        &root,
        &panel,
        if prompt.control {
            "仅允许查看"
        } else {
            "允许查看"
        },
        rect(188.0, 373.0, view_width, 42.0),
        1001,
        if prompt.control { 0xF0F6FF } else { 0x2862F0 },
        if prompt.control { 0x3673FF } else { 0xFFFFFF },
    );
    let control = prompt.control.then(|| {
        button(
            mtm,
            &root,
            &panel,
            "允许控制",
            rect(427.0, 373.0, 239.0, 42.0),
            1002,
            0x2862F0,
            0xFFFFFF,
        )
    });
    // All key-loop views are retained by the content view for the modal lifetime.
    unsafe {
        reject.setNextKeyView(Some(&view));
        view.setNextKeyView(Some(control.as_deref().map(|v| &**v).unwrap_or(&checkbox)));
        if let Some(control) = &control {
            control.setNextKeyView(Some(&checkbox));
        }
        checkbox.setNextKeyView(Some(&reject));
    }
    let app = NSApplication::sharedApplication(mtm);
    // Add to the modal run-loop explicitly: a default-mode timer would stop
    // firing during runModalForWindow and leave expired prompts on screen.
    let expire = block2::RcBlock::new(move |_timer: std::ptr::NonNull<NSTimer>| {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).stopModalWithCode(1000);
        }
    });
    let timer = unsafe {
        NSTimer::timerWithTimeInterval_repeats_block(remaining.as_secs_f64(), false, &expire)
    };
    unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSModalPanelRunLoopMode) };
    parent.beginSheet_completionHandler(&panel, None);
    panel.makeKeyAndOrderFront(None);
    let response = app.runModalForWindow(&panel);
    timer.invalidate();
    let result = choice(response, prompt.control, checkbox.state() == 1);
    parent.endSheet(&panel);
    panel.orderOut(None);
    result
}
