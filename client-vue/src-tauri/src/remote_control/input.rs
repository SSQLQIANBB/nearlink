//! Strict DataChannel input decoding and the only native OS execution boundary.
//! No Tauri invoke exposes this module. All tests use a recording executor.
#![allow(dead_code)]
use super::guard::{InputContext, InputEnvelope, ReleasePlan, SessionGuard, StopReason};
use super::media_layout::{self, DisplaySnapshot};
use serde::{Deserialize, Serialize};
use std::time::Instant;

const MAX_INPUT_BYTES: usize = 4096;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq)]
pub enum InputAction {
    Move {
        x: f64,
        y: f64,
    },
    Button {
        x: f64,
        y: f64,
        button: u8,
        down: bool,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
    },
    Key {
        code: String,
        down: bool,
    },
    Text {
        text: String,
        commit_id: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputError {
    InvalidMessage,
    Unsupported,
    PermissionDenied,
    LayoutChanged,
    InjectionFailed,
    Expired,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputEnvironment {
    pub screen_id: String,
    pub layout_version: u64,
}

/// Implementations must return success only once the complete action is posted.
/// `release` is independent of lease/tickets and must attempt every ledger item
/// even if another release fails. It must never synthesize unowned key/button ups.
pub trait InputExecutor: Send {
    fn display_snapshot(&mut self) -> Result<DisplaySnapshot, InputError> {
        Err(InputError::Unsupported)
    }
    fn preflight(&mut self) -> Result<InputEnvironment, InputError>;
    fn execute(&mut self, action: &InputAction, deadline: Instant) -> Result<(), InputError>;
    fn release(&mut self, plan: &ReleasePlan) -> Result<(), InputError>;
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputAck {
    #[serde(flatten)]
    pub context: InputContext,
    pub seq: u64,
}
#[derive(Debug)]
pub struct InputFailure {
    pub reason: StopReason,
    pub pending_release: Option<ReleasePlan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireInput {
    version: u32,
    session_id: String,
    control_epoch: u64,
    input_epoch: u64,
    layout_version: u64,
    seq: u64,
    input_window_id: String,
    #[serde(rename = "type")]
    kind: String,
    payload: WirePayload,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum WirePayload {
    Move(Move),
    Button(Button),
    Wheel(Wheel),
    Key(Key),
    Text(Text),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Move {
    x: f64,
    y: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Button {
    x: f64,
    y: f64,
    button: u8,
    down: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wheel {
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
    unit: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Key {
    code: String,
    down: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Text {
    text: String,
    commit_id: String,
}

fn unit(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}
fn mouse_button(button: u8) -> Option<(u32, u32, u32)> {
    // DOM: left=0, middle=1, right=2. Quartz: left=0, right=1, middle=2.
    match button {
        0 => Some((0, 1, 2)),
        1 => Some((2, 25, 26)),
        2 => Some((1, 3, 4)),
        _ => None,
    }
}
fn decode(bytes: &[u8]) -> Result<(WireInput, InputAction), InputError> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err(InputError::InvalidMessage);
    }
    let input: WireInput = serde_json::from_slice(bytes).map_err(|_| InputError::InvalidMessage)?;
    if input.version != 1
        || !super::authorization::uuid(&input.session_id)
        || [
            input.control_epoch,
            input.input_epoch,
            input.layout_version,
            input.seq,
        ]
        .iter()
        .any(|n| *n == 0 || *n > MAX_SAFE_INTEGER)
        || super::authorization::decode(&input.input_window_id, Some(32)).is_err()
    {
        return Err(InputError::InvalidMessage);
    }
    let action = match (&*input.kind, &input.payload) {
        ("move", WirePayload::Move(p)) if unit(p.x) && unit(p.y) => {
            InputAction::Move { x: p.x, y: p.y }
        }
        ("button", WirePayload::Button(p)) if unit(p.x) && unit(p.y) && p.button <= 2 => {
            InputAction::Button {
                x: p.x,
                y: p.y,
                button: p.button,
                down: p.down,
            }
        }
        ("wheel", WirePayload::Wheel(p))
            if unit(p.x)
                && unit(p.y)
                && p.unit == "css-pixel"
                && [p.delta_x, p.delta_y]
                    .iter()
                    .all(|v| v.is_finite() && v.abs() <= 2000.0) =>
        {
            InputAction::Wheel {
                x: p.x,
                y: p.y,
                delta_x: p.delta_x,
                delta_y: p.delta_y,
            }
        }
        ("key", WirePayload::Key(p)) if key_code(&p.code).is_some() => InputAction::Key {
            code: p.code.clone(),
            down: p.down,
        },
        ("text", WirePayload::Text(p))
            if !p.text.is_empty()
                && p.text.chars().count() <= 1024
                && !p.text.contains('\0')
                && super::authorization::identifier(&p.commit_id) =>
        {
            InputAction::Text {
                text: p.text.clone(),
                commit_id: p.commit_id.clone(),
            }
        }
        _ => return Err(InputError::InvalidMessage),
    };
    Ok((input, action))
}

/// A suspended session may discard an in-flight frame whose ticket/sequence
/// became obsolete during release-all. Its wire shape and session binding must
/// still be valid; this never admits, executes, acknowledges or advances it.
pub(super) fn validate_suspended_input(
    bytes: &[u8],
    session_id: &str,
    control_epoch: u64,
    layout_version: u64,
    highest_issued_input_epoch: u64,
) -> Result<(), InputError> {
    let (input, _) = decode(bytes)?;
    if input.session_id != session_id
        || input.control_epoch != control_epoch
        || input.layout_version != layout_version
        || input.input_epoch > highest_issued_input_epoch
    {
        return Err(InputError::InvalidMessage);
    }
    Ok(())
}

pub fn apply_release<E: InputExecutor + ?Sized>(
    plan: &ReleasePlan,
    executor: &mut E,
) -> Result<(), InputError> {
    if plan.keys.is_empty() && plan.buttons.is_empty() {
        return Ok(());
    }
    executor.release(plan)
}
fn failed<E: InputExecutor + ?Sized>(
    reason: StopReason,
    plan: ReleasePlan,
    executor: &mut E,
) -> InputFailure {
    let pending_release = apply_release(&plan, executor).err().map(|_| plan);
    InputFailure {
        reason,
        pending_release,
    }
}

/// Decode, inspect the real OS environment, validate at this exact execution
/// boundary, then record only successfully injected downs in the session ledger.
pub fn dispatch_input<E: InputExecutor + ?Sized>(
    guard: &mut SessionGuard,
    executor: &mut E,
    bytes: &[u8],
    now: Instant,
) -> Result<InputAck, InputFailure> {
    let (input, action) = match decode(bytes) {
        Ok(value) => value,
        Err(_) => {
            return Err(failed(
                StopReason::InvalidInput,
                guard.pause(StopReason::InvalidInput),
                executor,
            ))
        }
    };
    let environment = match executor.preflight() {
        Ok(value) => value,
        Err(error) => {
            let reason = if error == InputError::LayoutChanged {
                StopReason::LayoutChanged
            } else {
                StopReason::SystemUnavailable
            };
            return Err(failed(reason, guard.stop(reason), executor));
        }
    };
    if guard.expected_environment()
        != Some((environment.screen_id.as_str(), environment.layout_version))
    {
        return Err(failed(
            StopReason::LayoutChanged,
            guard.stop(StopReason::LayoutChanged),
            executor,
        ));
    }
    let envelope = InputEnvelope {
        version: input.version,
        session_id: &input.session_id,
        control_epoch: input.control_epoch,
        input_epoch: input.input_epoch,
        layout_version: input.layout_version,
        seq: input.seq,
        input_window_id: &input.input_window_id,
        byte_len: bytes.len(),
    };
    if let Err((reason, release)) = guard.admit(&envelope, now, true) {
        return Err(failed(reason, release, executor));
    }
    if let InputAction::Text { commit_id, .. } = &action {
        if !guard.claim_text_commit(commit_id) {
            return Err(failed(
                StopReason::Replay,
                guard.pause(StopReason::Replay),
                executor,
            ));
        }
    }
    // Equal states are idempotent: never synthesize double downs, or release a
    // key/button held only by the local user. v1 has no explicit repeat event.
    let unchanged_state = match &action {
        InputAction::Key { code, down } => guard.is_key_pressed(code) == *down,
        InputAction::Button { button, down, .. } => guard.is_button_pressed(*button) == *down,
        _ => false,
    };
    if !unchanged_state {
        let deadline = guard
            .execution_deadline(&input.input_window_id)
            .expect("admitted input window");
        if let Err(error) = executor.execute(&action, deadline) {
            let reason = match error {
                InputError::Expired => StopReason::InputExpired,
                InputError::LayoutChanged => StopReason::LayoutChanged,
                InputError::PermissionDenied => StopReason::SystemUnavailable,
                _ => StopReason::InjectionFailed,
            };
            let plan = if error == InputError::Expired {
                guard.pause(reason)
            } else {
                guard.stop(reason)
            };
            return Err(failed(reason, plan, executor));
        }
        match &action {
            InputAction::Key { code, down } => guard.record_key(code, *down),
            InputAction::Button { button, down, .. } => guard.record_button(*button, *down),
            _ => {}
        }
    }
    Ok(InputAck {
        context: InputContext {
            session_id: input.session_id,
            control_epoch: input.control_epoch,
            input_epoch: input.input_epoch,
            layout_version: input.layout_version,
        },
        seq: input.seq,
    })
}

/// Stage every down/up pair before any post. Unicode scalar boundaries are
/// preserved. A later preflight failure can leave partial text, but never a
/// stuck key; the failed commit stays consumed and must not be replayed.
fn post_unicode_pairs<P>(
    text: &str,
    mut prepare: impl FnMut(&[u16]) -> Result<P, InputError>,
    mut preflight: impl FnMut() -> Result<(), InputError>,
    mut post_pair: impl FnMut(P),
) -> Result<(), InputError> {
    if text.is_empty() || text.chars().count() > 1024 || text.contains('\0') {
        return Err(InputError::InvalidMessage);
    }
    let mut chunks = Vec::new();
    let mut chunk = Vec::with_capacity(16);
    for scalar in text.chars() {
        let mut units = [0u16; 2];
        let encoded = scalar.encode_utf16(&mut units);
        if chunk.len() + encoded.len() > 16 {
            chunks.push(std::mem::take(&mut chunk));
        }
        chunk.extend_from_slice(encoded);
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    let pairs: Vec<P> = chunks
        .iter()
        .map(|chunk| prepare(chunk))
        .collect::<Result<_, _>>()?;
    for pair in pairs {
        preflight()?;
        // No fallible operation is allowed between the down and matching up.
        post_pair(pair);
    }
    Ok(())
}

// Permission/layout FFI may itself block. Recheck after it finishes, directly
// before a post (or an indivisible Unicode down/up pair).
fn preflight_before_post(
    deadline: Instant,
    mut clock: impl FnMut() -> Instant,
    check: impl FnOnce() -> Result<(), InputError>,
) -> Result<(), InputError> {
    if clock() >= deadline {
        return Err(InputError::Expired);
    }
    check()?;
    if clock() >= deadline {
        return Err(InputError::Expired);
    }
    Ok(())
}

/// Physical code mapping from the macOS SDK HIToolbox/Events.h. CapsLock and
/// Insert are intentionally unsupported: no fabricated toggle or Help mapping.
fn key_code(code: &str) -> Option<u16> {
    Some(match code {
        "KeyA" => 0,
        "KeyS" => 1,
        "KeyD" => 2,
        "KeyF" => 3,
        "KeyH" => 4,
        "KeyG" => 5,
        "KeyZ" => 6,
        "KeyX" => 7,
        "KeyC" => 8,
        "KeyV" => 9,
        "KeyB" => 11,
        "KeyQ" => 12,
        "KeyW" => 13,
        "KeyE" => 14,
        "KeyR" => 15,
        "KeyY" => 16,
        "KeyT" => 17,
        "Digit1" => 18,
        "Digit2" => 19,
        "Digit3" => 20,
        "Digit4" => 21,
        "Digit6" => 22,
        "Digit5" => 23,
        "Equal" => 24,
        "Digit9" => 25,
        "Digit7" => 26,
        "Minus" => 27,
        "Digit8" => 28,
        "Digit0" => 29,
        "BracketRight" => 30,
        "KeyO" => 31,
        "KeyU" => 32,
        "BracketLeft" => 33,
        "KeyI" => 34,
        "KeyP" => 35,
        "Enter" => 36,
        "KeyL" => 37,
        "KeyJ" => 38,
        "Quote" => 39,
        "KeyK" => 40,
        "Semicolon" => 41,
        "Backslash" => 42,
        "Comma" => 43,
        "Slash" => 44,
        "KeyN" => 45,
        "KeyM" => 46,
        "Period" => 47,
        "Tab" => 48,
        "Space" => 49,
        "Backquote" => 50,
        "Backspace" => 51,
        "Escape" => 53,
        "MetaRight" => 54,
        "MetaLeft" => 55,
        "ShiftLeft" => 56,
        "AltLeft" => 58,
        "ControlLeft" => 59,
        "ShiftRight" => 60,
        "AltRight" => 61,
        "ControlRight" => 62,
        "NumpadDecimal" => 65,
        "NumpadMultiply" => 67,
        "NumpadAdd" => 69,
        "NumpadDivide" => 75,
        "NumpadEnter" => 76,
        "NumpadSubtract" => 78,
        "Numpad0" => 82,
        "Numpad1" => 83,
        "Numpad2" => 84,
        "Numpad3" => 85,
        "Numpad4" => 86,
        "Numpad5" => 87,
        "Numpad6" => 88,
        "Numpad7" => 89,
        "Numpad8" => 91,
        "Numpad9" => 92,
        "F5" => 96,
        "F6" => 97,
        "F7" => 98,
        "F3" => 99,
        "F8" => 100,
        "F9" => 101,
        "F11" => 103,
        "F10" => 109,
        "F12" => 111,
        "Home" => 115,
        "PageUp" => 116,
        "Delete" => 117,
        "F4" => 118,
        "End" => 119,
        "F2" => 120,
        "PageDown" => 121,
        "F1" => 122,
        "ArrowLeft" => 123,
        "ArrowRight" => 124,
        "ArrowDown" => 125,
        "ArrowUp" => 126,
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{collections::BTreeSet, ffi::c_void, ptr};
    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceCreate(state: i32) -> *mut c_void;
        fn CGEventCreateMouseEvent(
            source: *mut c_void,
            event_type: u32,
            position: Point,
            button: u32,
        ) -> *mut c_void;
        fn CGEventCreateKeyboardEvent(source: *mut c_void, key: u16, down: bool) -> *mut c_void;
        fn CGEventCreateScrollWheelEvent2(
            source: *mut c_void,
            units: u32,
            wheels: u32,
            y: i32,
            x: i32,
            z: i32,
        ) -> *mut c_void;
        fn CGEventKeyboardSetUnicodeString(event: *mut c_void, length: usize, text: *const u16);
        fn CGEventSetFlags(event: *mut c_void, flags: u64);
        fn CGEventSetLocation(event: *mut c_void, point: Point);
        fn CGEventPost(tap: u32, event: *mut c_void);
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
    }
    type Layout = DisplaySnapshot;
    fn layout() -> Result<Layout, InputError> {
        if unsafe { AXIsProcessTrusted() } == 0 {
            return Err(InputError::PermissionDenied);
        }
        media_layout::primary_display_snapshot().map_err(|_| InputError::LayoutChanged)
    }
    struct Event(*mut c_void);
    impl Event {
        fn new(ptr: *mut c_void) -> Result<Self, InputError> {
            if ptr.is_null() {
                Err(InputError::InjectionFailed)
            } else {
                Ok(Self(ptr))
            }
        }
    }
    impl Drop for Event {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    pub struct MacOsInputExecutor {
        initial: Layout,
        layout_version: u64,
        source: *mut c_void,
        keys: BTreeSet<String>,
        buttons: BTreeSet<u8>,
        last_point: Point,
    }
    // Owned by one supervisor at a time; all methods require &mut self. Core
    // Graphics event sources are not tied to a UI thread and never shared here.
    unsafe impl Send for MacOsInputExecutor {}
    impl MacOsInputExecutor {
        /// Read geometry without AX access so view-only sessions can start.
        /// Input preflight and every post still require AX permission.
        pub fn new_primary_screen(layout_version: u64) -> Result<Self, InputError> {
            if layout_version == 0 {
                return Err(InputError::LayoutChanged);
            }
            let initial = media_layout::primary_display_snapshot()
                .map_err(|_| InputError::LayoutChanged)?;
            Ok(Self {
                initial,
                layout_version,
                source: ptr::null_mut(),
                keys: BTreeSet::new(),
                buttons: BTreeSet::new(),
                last_point: Point {
                    x: initial.bounds.x,
                    y: initial.bounds.y,
                },
            })
        }
        fn source(&mut self) -> Result<*mut c_void, InputError> {
            if self.source.is_null() {
                self.source = unsafe { CGEventSourceCreate(-1) };
            }
            if self.source.is_null() {
                Err(InputError::InjectionFailed)
            } else {
                Ok(self.source)
            }
        }
        fn point(&self, x: f64, y: f64) -> Result<Point, InputError> {
            let (x, y) = self.initial.point(x, y).ok_or(InputError::InvalidMessage)?;
            Ok(Point { x, y })
        }
        fn flags(keys: &BTreeSet<String>) -> u64 {
            let mut flags = 0;
            for (prefix, mask) in [
                ("Shift", 1u64 << 17),
                ("Control", 1 << 18),
                ("Alt", 1 << 19),
                ("Meta", 1 << 20),
            ] {
                if keys.iter().any(|key| key.starts_with(prefix)) {
                    flags |= mask;
                }
            }
            flags
        }
        fn post(event: Event, flags: u64) {
            unsafe {
                CGEventSetFlags(event.0, flags);
                CGEventPost(0, event.0);
            }
        }
        fn check_post(&self, deadline: Option<Instant>) -> Result<(), InputError> {
            if let Some(deadline) = deadline {
                preflight_before_post(deadline, Instant::now, || {
                    if layout()? != self.initial {
                        Err(InputError::LayoutChanged)
                    } else {
                        Ok(())
                    }
                })?;
            }
            Ok(())
        }
        fn key(
            &mut self,
            code: &str,
            down: bool,
            deadline: Option<Instant>,
        ) -> Result<(), InputError> {
            let key = key_code(code).ok_or(InputError::Unsupported)?;
            let source = self.source()?;
            let event = Event::new(unsafe { CGEventCreateKeyboardEvent(source, key, down) })?;
            let mut next = self.keys.clone();
            if down {
                next.insert(code.to_owned());
            } else {
                next.remove(code);
            }
            self.check_post(deadline)?;
            Self::post(event, Self::flags(&next));
            self.keys = next;
            Ok(())
        }
        fn button(
            &mut self,
            point: Point,
            button: u8,
            down: bool,
            deadline: Option<Instant>,
        ) -> Result<(), InputError> {
            let (native_button, down_type, up_type) =
                mouse_button(button).ok_or(InputError::Unsupported)?;
            let source = self.source()?;
            let event = Event::new(unsafe {
                CGEventCreateMouseEvent(
                    source,
                    if down { down_type } else { up_type },
                    point,
                    native_button,
                )
            })?;
            self.check_post(deadline)?;
            Self::post(event, Self::flags(&self.keys));
            self.last_point = point;
            if down {
                self.buttons.insert(button);
            } else {
                self.buttons.remove(&button);
            }
            Ok(())
        }
    }
    impl Drop for MacOsInputExecutor {
        fn drop(&mut self) {
            // One final bounded attempt, only for this executor's still-owned
            // injections. OS acceptance cannot be guaranteed after permission
            // loss; the supervisor retains/retries its plan before reaching Drop.
            let plan = ReleasePlan {
                keys: self.keys.clone(),
                buttons: self.buttons.clone(),
                stop_media: false,
            };
            if (!plan.keys.is_empty() || !plan.buttons.is_empty()) && self.release(&plan).is_err() {
                eprintln!("remote_input_cleanup_incomplete");
            }
            if !self.source.is_null() {
                unsafe { CFRelease(self.source) };
            }
        }
    }
    impl InputExecutor for MacOsInputExecutor {
        fn display_snapshot(&mut self) -> Result<DisplaySnapshot, InputError> {
            let current =
                media_layout::primary_display_snapshot().map_err(|_| InputError::LayoutChanged)?;
            if current != self.initial {
                return Err(InputError::LayoutChanged);
            }
            Ok(current)
        }
        fn preflight(&mut self) -> Result<InputEnvironment, InputError> {
            if layout()? != self.initial {
                return Err(InputError::LayoutChanged);
            }
            Ok(InputEnvironment {
                screen_id: "primary".into(),
                layout_version: self.layout_version,
            })
        }
        fn execute(&mut self, action: &InputAction, deadline: Instant) -> Result<(), InputError> {
            self.preflight()?;
            match action {
                InputAction::Key { code, down } => self.key(code, *down, Some(deadline)),
                InputAction::Button { x, y, button, down } => {
                    self.button(self.point(*x, *y)?, *button, *down, Some(deadline))
                }
                InputAction::Move { x, y } => {
                    let point = self.point(*x, *y)?;
                    let (kind, button) = if self.buttons.contains(&0) {
                        (6, 0)
                    } else if self.buttons.contains(&2) {
                        (7, 1)
                    } else if self.buttons.contains(&1) {
                        (27, 2)
                    } else {
                        (5, 0)
                    };
                    let source = self.source()?;
                    let event = Event::new(unsafe {
                        CGEventCreateMouseEvent(source, kind, point, button)
                    })?;
                    self.check_post(Some(deadline))?;
                    Self::post(event, Self::flags(&self.keys));
                    self.last_point = point;
                    Ok(())
                }
                InputAction::Wheel {
                    x,
                    y,
                    delta_x,
                    delta_y,
                } => {
                    let source = self.source()?;
                    // DOM wheel-positive scrolls down/right; Quartz wheel-positive is up/left.
                    let event = Event::new(unsafe {
                        CGEventCreateScrollWheelEvent2(
                            source,
                            0,
                            2,
                            -delta_y.round() as i32,
                            -delta_x.round() as i32,
                            0,
                        )
                    })?;
                    unsafe {
                        CGEventSetLocation(event.0, self.point(*x, *y)?);
                    }
                    self.check_post(Some(deadline))?;
                    Self::post(event, Self::flags(&self.keys));
                    Ok(())
                }
                InputAction::Text { text, .. } => {
                    // Text commits do not inherit modifier shortcuts.
                    if !self.keys.is_empty() {
                        return Err(InputError::Unsupported);
                    }
                    let source = self.source()?;
                    let expected = self.initial;
                    post_unicode_pairs(
                        text,
                        |units| {
                            let down =
                                Event::new(unsafe { CGEventCreateKeyboardEvent(source, 0, true) })?;
                            let up = Event::new(unsafe {
                                CGEventCreateKeyboardEvent(source, 0, false)
                            })?;
                            unsafe {
                                CGEventKeyboardSetUnicodeString(
                                    down.0,
                                    units.len(),
                                    units.as_ptr(),
                                );
                                CGEventKeyboardSetUnicodeString(up.0, units.len(), units.as_ptr());
                            }
                            Ok((down, up))
                        },
                        || {
                            preflight_before_post(deadline, Instant::now, || {
                                if layout()? == expected {
                                    Ok(())
                                } else {
                                    Err(InputError::LayoutChanged)
                                }
                            })
                        },
                        |(down, up)| {
                            Self::post(down, 0);
                            Self::post(up, 0);
                        },
                    )
                }
            }
        }
        fn release(&mut self, plan: &ReleasePlan) -> Result<(), InputError> {
            // Do not gate cleanup on permission/lease/layout: try every owned up
            // even after preflight fails. Retain failed items for runtime retry.
            let mut failed = false;
            for key in &plan.keys {
                if self.keys.contains(key) && self.key(key, false, None).is_err() {
                    failed = true;
                }
            }
            for button in &plan.buttons {
                if self.buttons.contains(button)
                    && self.button(self.last_point, *button, false, None).is_err()
                {
                    failed = true;
                }
            }
            if failed {
                Err(InputError::InjectionFailed)
            } else {
                Ok(())
            }
        }
    }
}
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
// Production activation remains gated; the harness uses a recording sink.
pub use macos::MacOsInputExecutor;

#[cfg(not(target_os = "macos"))]
pub struct MacOsInputExecutor;
#[cfg(not(target_os = "macos"))]
impl MacOsInputExecutor {
    pub fn new_primary_screen(_: u64) -> Result<Self, InputError> {
        Err(InputError::Unsupported)
    }
}
#[cfg(not(target_os = "macos"))]
impl InputExecutor for MacOsInputExecutor {
    fn preflight(&mut self) -> Result<InputEnvironment, InputError> {
        Err(InputError::Unsupported)
    }
    fn execute(&mut self, _: &InputAction, _: Instant) -> Result<(), InputError> {
        Err(InputError::Unsupported)
    }
    fn release(&mut self, _: &ReleasePlan) -> Result<(), InputError> {
        Err(InputError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::super::guard::{test_support::live_guard, InputWindow};
    use super::*;
    use serde_json::{json, Value};
    use std::{collections::BTreeSet, time::Duration};
    #[derive(Default)]
    struct RecordingSink {
        events: Vec<InputAction>,
        releases: Vec<ReleasePlan>,
        unavailable: bool,
        layout_changed: bool,
        fail: bool,
        fail_release: bool,
    }
    impl InputExecutor for RecordingSink {
        fn preflight(&mut self) -> Result<InputEnvironment, InputError> {
            if self.layout_changed {
                Err(InputError::LayoutChanged)
            } else if self.unavailable {
                Err(InputError::PermissionDenied)
            } else {
                Ok(InputEnvironment {
                    screen_id: "primary".into(),
                    layout_version: 1,
                })
            }
        }
        fn execute(&mut self, action: &InputAction, _: Instant) -> Result<(), InputError> {
            if self.fail {
                Err(InputError::InjectionFailed)
            } else {
                self.events.push(action.clone());
                Ok(())
            }
        }
        fn release(&mut self, plan: &ReleasePlan) -> Result<(), InputError> {
            self.releases.push(ReleasePlan {
                keys: plan.keys.clone(),
                buttons: plan.buttons.clone(),
                stop_media: plan.stop_media,
            });
            if self.fail_release {
                Err(InputError::InjectionFailed)
            } else {
                Ok(())
            }
        }
    }
    fn message(window: &InputWindow, seq: u64, kind: &str, payload: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"version":1,"sessionId":window.context.session_id,"controlEpoch":window.context.control_epoch,
            "inputEpoch":window.context.input_epoch,"layoutVersion":window.context.layout_version,"inputWindowId":window.input_window_id,
            "seq":seq,"type":kind,"payload":payload})).unwrap()
    }
    #[test]
    fn real_verified_guard_dispatches_and_acknowledges_ordered_input() {
        let now = Instant::now();
        let (mut guard, window) = live_guard(now);
        let mut sink = RecordingSink::default();
        let first = message(&window, 1, "key", json!({"code":"ControlLeft","down":true}));
        assert_eq!(
            dispatch_input(&mut guard, &mut sink, &first, now)
                .unwrap()
                .seq,
            1
        );
        let second = message(
            &window,
            2,
            "button",
            json!({"x":0.25,"y":0.75,"button":0,"down":true}),
        );
        assert_eq!(
            dispatch_input(&mut guard, &mut sink, &second, now)
                .unwrap()
                .seq,
            2
        );
        let plan = guard.stop(StopReason::LocalStop);
        apply_release(&plan, &mut sink).unwrap();
        assert_eq!(plan.keys, BTreeSet::from(["ControlLeft".into()]));
        assert_eq!(plan.buttons, BTreeSet::from([0]));
        assert_eq!(sink.events.len(), 2);
        assert!(plan.stop_media);
    }
    #[test]
    fn strict_decode_rejects_unknown_duplicate_wrong_payload_and_limits() {
        let (_, window) = live_guard(Instant::now());
        let valid = message(&window, 1, "move", json!({"x":0.2,"y":0.4}));
        assert!(decode(&valid).is_ok());
        let mut bad: Value = serde_json::from_slice(&valid).unwrap();
        bad["accepted"] = true.into();
        assert!(decode(&serde_json::to_vec(&bad).unwrap()).is_err());
        let text = String::from_utf8(valid.clone()).unwrap();
        assert!(decode(
            text.replacen("\"version\":1", "\"version\":1,\"version\":1", 1)
                .as_bytes()
        )
        .is_err());
        assert!(decode(
            text.replacen("\"x\":0.2", "\"x\":0.2,\"x\":0.2", 1)
                .as_bytes()
        )
        .is_err());
        for payload in [
            json!({"x":-0.1,"y":0.4}),
            json!({"x":0.2,"y":0.4,"extra":true}),
            json!({"code":"KeyA","down":true}),
        ] {
            assert!(decode(&message(&window, 1, "move", payload)).is_err());
        }
        assert!(decode(&vec![b' '; 4097]).is_err());
        assert!(decode(&message(
            &window,
            1,
            "wheel",
            json!({"x":0.2,"y":0.4,"deltaX":0,"deltaY":2001,"unit":"css-pixel"})
        ))
        .is_err());
        assert!(decode(&message(
            &window,
            1,
            "key",
            json!({"code":"CapsLock","down":true})
        ))
        .is_err());
    }
    #[test]
    fn unowned_key_and_button_ups_never_release_local_physical_input() {
        let now = Instant::now();
        let (mut guard, window) = live_guard(now);
        let mut sink = RecordingSink::default();
        dispatch_input(
            &mut guard,
            &mut sink,
            &message(&window, 1, "key", json!({"code":"KeyA","down":false})),
            now,
        )
        .unwrap();
        dispatch_input(
            &mut guard,
            &mut sink,
            &message(
                &window,
                2,
                "button",
                json!({"x":0.0,"y":0.0,"button":2,"down":false}),
            ),
            now,
        )
        .unwrap();
        assert!(sink.events.is_empty());
        assert!(guard.stop(StopReason::LocalStop).keys.is_empty());
    }
    #[test]
    fn duplicate_downs_are_acknowledged_without_second_os_event() {
        let now = Instant::now();
        let (mut guard, window) = live_guard(now);
        let mut sink = RecordingSink::default();
        for seq in 1..=2 {
            dispatch_input(
                &mut guard,
                &mut sink,
                &message(&window, seq, "key", json!({"code":"KeyA","down":true})),
                now,
            )
            .unwrap();
        }
        for seq in 3..=4 {
            dispatch_input(
                &mut guard,
                &mut sink,
                &message(
                    &window,
                    seq,
                    "button",
                    json!({"x":0.3,"y":0.3,"button":0,"down":true}),
                ),
                now,
            )
            .unwrap();
        }
        assert_eq!(sink.events.len(), 2);
        let plan = guard.stop(StopReason::LocalStop);
        assert_eq!(plan.keys.len(), 1);
        assert_eq!(plan.buttons.len(), 1);
    }
    #[test]
    fn changed_primary_layout_stops_before_os_execution_and_releases_ledger() {
        let now = Instant::now();
        let (mut guard, window) = live_guard(now);
        let mut sink = RecordingSink::default();
        dispatch_input(
            &mut guard,
            &mut sink,
            &message(&window, 1, "key", json!({"code":"KeyA","down":true})),
            now,
        )
        .unwrap();
        sink.layout_changed = true;
        let failure = dispatch_input(
            &mut guard,
            &mut sink,
            &message(&window, 2, "move", json!({"x":0.3,"y":0.3})),
            now,
        )
        .unwrap_err();
        assert_eq!(failure.reason, StopReason::LayoutChanged);
        assert!(sink.releases[0].stop_media);
        assert_eq!(sink.events.len(), 1);
    }
    #[test]
    fn unicode_staging_preserves_surrogates_and_prepares_all_pairs_before_any_post() {
        let text = format!("{}👋中文", "a".repeat(15));
        let mut posted = Vec::new();
        post_unicode_pairs(
            &text,
            |units| Ok(units.to_vec()),
            || Ok(()),
            |units| posted.push(units),
        )
        .unwrap();
        assert!(posted
            .iter()
            .all(|chunk| chunk.len() <= 16 && String::from_utf16(chunk).is_ok()));
        assert_eq!(String::from_utf16(&posted.concat()).unwrap(), text);
        let mut allocations = 0;
        let mut events = 0;
        assert!(post_unicode_pairs(
            &"a".repeat(40),
            |_| {
                allocations += 1;
                if allocations == 3 {
                    Err(InputError::InjectionFailed)
                } else {
                    Ok(())
                }
            },
            || Ok(()),
            |_| events += 2
        )
        .is_err());
        assert_eq!(events, 0);
    }
    #[test]
    fn unicode_mid_commit_failure_leaves_only_complete_down_up_pairs() {
        let mut checks = 0;
        let mut events = Vec::new();
        let error = post_unicode_pairs(
            &"a".repeat(40),
            |_| Ok(()),
            || {
                checks += 1;
                if checks == 2 {
                    Err(InputError::Expired)
                } else {
                    Ok(())
                }
            },
            |_| {
                events.push("down");
                events.push("up");
            },
        )
        .unwrap_err();
        assert_eq!(error, InputError::Expired);
        assert_eq!(events, ["down", "up"]);
    }
    #[test]
    fn stale_ticket_and_sequence_replay_pause_and_release_only_injected_ledger() {
        for expired in [false, true] {
            let now = Instant::now();
            let (mut guard, window) = live_guard(now);
            let mut sink = RecordingSink::default();
            let key = message(&window, 1, "key", json!({"code":"KeyA","down":true}));
            dispatch_input(&mut guard, &mut sink, &key, now).unwrap();
            let event = if expired {
                message(&window, 2, "move", json!({"x":0.0,"y":0.0}))
            } else {
                key
            };
            let error = dispatch_input(
                &mut guard,
                &mut sink,
                &event,
                now + if expired {
                    Duration::from_millis(500)
                } else {
                    Duration::ZERO
                },
            )
            .unwrap_err();
            assert_eq!(
                error.reason,
                if expired {
                    StopReason::InputExpired
                } else {
                    StopReason::SequenceMismatch
                }
            );
            assert_eq!(sink.events.len(), 1);
            assert_eq!(sink.releases[0].keys, BTreeSet::from(["KeyA".into()]));
        }
    }
    #[test]
    fn failed_down_is_never_ledgered_and_previous_down_is_released() {
        let now = Instant::now();
        let (mut guard, window) = live_guard(now);
        let mut sink = RecordingSink::default();
        dispatch_input(
            &mut guard,
            &mut sink,
            &message(&window, 1, "key", json!({"code":"KeyA","down":true})),
            now,
        )
        .unwrap();
        sink.fail = true;
        let failure = dispatch_input(
            &mut guard,
            &mut sink,
            &message(&window, 2, "key", json!({"code":"KeyB","down":true})),
            now,
        )
        .unwrap_err();
        assert_eq!(failure.reason, StopReason::InjectionFailed);
        assert_eq!(sink.releases[0].keys, BTreeSet::from(["KeyA".into()]));
    }
    #[test]
    fn permission_loss_stops_before_execute_and_retains_failed_release_for_retry() {
        let now = Instant::now();
        let (mut guard, window) = live_guard(now);
        let mut sink = RecordingSink::default();
        dispatch_input(
            &mut guard,
            &mut sink,
            &message(
                &window,
                1,
                "button",
                json!({"x":0.5,"y":0.5,"button":1,"down":true}),
            ),
            now,
        )
        .unwrap();
        sink.unavailable = true;
        sink.fail_release = true;
        let failure = dispatch_input(
            &mut guard,
            &mut sink,
            &message(&window, 2, "move", json!({"x":0.8,"y":0.8})),
            now,
        )
        .unwrap_err();
        let pending = failure.pending_release.unwrap();
        assert_eq!(pending.buttons, BTreeSet::from([1]));
        assert!(pending.stop_media);
        assert_eq!(sink.events.len(), 1);
        sink.fail_release = false;
        apply_release(&pending, &mut sink).unwrap();
    }
    #[test]
    fn unicode_commits_are_bounded_and_cannot_replay_after_focus_rearm() {
        let now = Instant::now();
        let (mut guard, window) = live_guard(now);
        let mut sink = RecordingSink::default();
        let text = json!({"text":"中文👋","commitId":"commit-1"});
        dispatch_input(
            &mut guard,
            &mut sink,
            &message(&window, 1, "text", text.clone()),
            now,
        )
        .unwrap();
        guard.release_input(StopReason::LocalStop);
        guard.arm(1, 1, now, true).unwrap();
        let next = guard.issue_input_window(now).unwrap();
        assert_eq!(
            dispatch_input(&mut guard, &mut sink, &message(&next, 1, "text", text), now)
                .unwrap_err()
                .reason,
            StopReason::Replay
        );
        assert_eq!(sink.events.len(), 1);
        assert!(decode(&message(
            &window,
            2,
            "text",
            json!({"text":"a".repeat(1025),"commitId":"commit-2"})
        ))
        .is_err());
    }
    #[test]
    fn pointer_normalization_and_dom_button_mapping_are_explicit() {
        assert_eq!(
            DisplaySnapshot {
                display_id: 1,
                bounds: media_layout::Rect {
                    x: -1920.0,
                    y: 100.0,
                    width: 1920.0,
                    height: 1080.0
                },
                pixels: media_layout::PixelSize {
                    width: 1920,
                    height: 1080
                },
                rotation_degrees: 0
            }
            .point(0.0, 0.0)
            .unwrap(),
            (-1920.0, 100.0)
        );
        assert_eq!(
            DisplaySnapshot {
                display_id: 1,
                bounds: media_layout::Rect {
                    x: -1920.0,
                    y: 100.0,
                    width: 1920.0,
                    height: 1080.0
                },
                pixels: media_layout::PixelSize {
                    width: 1920,
                    height: 1080
                },
                rotation_degrees: 0
            }
            .point(1.0, 1.0)
            .unwrap(),
            (-1.0, 1179.0)
        );
        assert_eq!(mouse_button(1), Some((2, 25, 26)));
        assert_eq!(mouse_button(2), Some((1, 3, 4)));
        assert_eq!(mouse_button(3), None);
        assert_eq!(key_code("MetaRight"), Some(54));
        assert_eq!(key_code("NumpadEnter"), Some(76));
        assert_eq!(key_code("Insert"), None);
        let (_, window) = live_guard(Instant::now());
        for button in 0..=2 {
            assert!(decode(&message(
                &window,
                1,
                "button",
                json!({"x":1.0,"y":0.0,"button":button,"down":true})
            ))
            .is_ok());
        }
        assert!(decode(&message(
            &window,
            1,
            "button",
            json!({"x":1.1,"y":0.0,"button":0,"down":true})
        ))
        .is_err());
    }
}

#[cfg(test)]
mod post_deadline_tests {
    use super::*;
    use std::{cell::Cell, time::Duration};
    #[test]
    fn layout_delay_cannot_cross_deadline_and_still_post_a_unicode_pair() {
        let start = Instant::now();
        let deadline = start + Duration::from_millis(100);
        let clock = Cell::new(start);
        let posted = Cell::new(0);
        let result = post_unicode_pairs(
            "中文🙂",
            |_| Ok(()),
            || {
                preflight_before_post(
                    deadline,
                    || clock.get(),
                    || {
                        clock.set(deadline);
                        Ok(())
                    },
                )
            },
            |_| posted.set(posted.get() + 1),
        );
        assert_eq!(result, Err(InputError::Expired));
        assert_eq!(posted.get(), 0);
    }
}
