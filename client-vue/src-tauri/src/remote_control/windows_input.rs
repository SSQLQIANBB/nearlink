//! Windows input stays behind the existing signed session/ticket guard.
use super::*;
use std::collections::BTreeSet;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

fn interactive_desktop() -> Result<(), InputError> {
    // Never inject into the lock screen or a UAC secure desktop.
    if !super::super::platform::interactive_desktop() {
        return Err(InputError::PermissionDenied);
    }
    Ok(())
}

fn scan_code(code: &str) -> Option<(u16, bool)> {
    let scan = match code {
        "Escape" => 0x01,
        "Digit1" => 0x02,
        "Digit2" => 0x03,
        "Digit3" => 0x04,
        "Digit4" => 0x05,
        "Digit5" => 0x06,
        "Digit6" => 0x07,
        "Digit7" => 0x08,
        "Digit8" => 0x09,
        "Digit9" => 0x0a,
        "Digit0" => 0x0b,
        "Minus" => 0x0c,
        "Equal" => 0x0d,
        "Backspace" => 0x0e,
        "Tab" => 0x0f,
        "KeyQ" => 0x10,
        "KeyW" => 0x11,
        "KeyE" => 0x12,
        "KeyR" => 0x13,
        "KeyT" => 0x14,
        "KeyY" => 0x15,
        "KeyU" => 0x16,
        "KeyI" => 0x17,
        "KeyO" => 0x18,
        "KeyP" => 0x19,
        "BracketLeft" => 0x1a,
        "BracketRight" => 0x1b,
        "Enter" | "NumpadEnter" => 0x1c,
        "ControlLeft" | "ControlRight" => 0x1d,
        "KeyA" => 0x1e,
        "KeyS" => 0x1f,
        "KeyD" => 0x20,
        "KeyF" => 0x21,
        "KeyG" => 0x22,
        "KeyH" => 0x23,
        "KeyJ" => 0x24,
        "KeyK" => 0x25,
        "KeyL" => 0x26,
        "Semicolon" => 0x27,
        "Quote" => 0x28,
        "Backquote" => 0x29,
        "ShiftLeft" => 0x2a,
        "Backslash" => 0x2b,
        "KeyZ" => 0x2c,
        "KeyX" => 0x2d,
        "KeyC" => 0x2e,
        "KeyV" => 0x2f,
        "KeyB" => 0x30,
        "KeyN" => 0x31,
        "KeyM" => 0x32,
        "Comma" => 0x33,
        "Period" => 0x34,
        "Slash" | "NumpadDivide" => 0x35,
        "ShiftRight" => 0x36,
        "NumpadMultiply" => 0x37,
        "AltLeft" | "AltRight" => 0x38,
        "Space" => 0x39,
        "F1" => 0x3b,
        "F2" => 0x3c,
        "F3" => 0x3d,
        "F4" => 0x3e,
        "F5" => 0x3f,
        "F6" => 0x40,
        "F7" => 0x41,
        "F8" => 0x42,
        "F9" => 0x43,
        "F10" => 0x44,
        "F11" => 0x57,
        "F12" => 0x58,
        "Home" | "Numpad7" => 0x47,
        "ArrowUp" | "Numpad8" => 0x48,
        "PageUp" | "Numpad9" => 0x49,
        "NumpadSubtract" => 0x4a,
        "ArrowLeft" | "Numpad4" => 0x4b,
        "Numpad5" => 0x4c,
        "ArrowRight" | "Numpad6" => 0x4d,
        "NumpadAdd" => 0x4e,
        "End" | "Numpad1" => 0x4f,
        "ArrowDown" | "Numpad2" => 0x50,
        "PageDown" | "Numpad3" => 0x51,
        "Numpad0" => 0x52,
        "Delete" | "NumpadDecimal" => 0x53,
        "MetaLeft" => 0x5b,
        "MetaRight" => 0x5c,
        _ => return None,
    };
    let extended = matches!(
        code,
        "NumpadEnter"
            | "NumpadDivide"
            | "ControlRight"
            | "AltRight"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
            | "Delete"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "MetaLeft"
            | "MetaRight"
    );
    Some((scan, extended))
}
fn keyboard(scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: 0,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
fn mouse(x: i32, y: i32, data: u32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
fn post(event: INPUT) -> Result<(), InputError> {
    if unsafe { SendInput(1, &event, std::mem::size_of::<INPUT>() as i32) } != 1 {
        return Err(InputError::InjectionFailed);
    }
    Ok(())
}
fn button_flags(button: u8, down: bool) -> Result<u32, InputError> {
    match (button, down) {
        (0, true) => Ok(MOUSEEVENTF_LEFTDOWN),
        (0, false) => Ok(MOUSEEVENTF_LEFTUP),
        (1, true) => Ok(MOUSEEVENTF_MIDDLEDOWN),
        (1, false) => Ok(MOUSEEVENTF_MIDDLEUP),
        (2, true) => Ok(MOUSEEVENTF_RIGHTDOWN),
        (2, false) => Ok(MOUSEEVENTF_RIGHTUP),
        _ => Err(InputError::InvalidMessage),
    }
}
pub struct WindowsInputExecutor {
    initial: DisplaySnapshot,
    layout_version: u64,
    keys: BTreeSet<String>,
    buttons: BTreeSet<u8>,
    unicode_down: Option<u16>,
}
impl WindowsInputExecutor {
    pub fn new_primary_screen(layout_version: u64) -> Result<Self, InputError> {
        interactive_desktop()?;
        Ok(Self {
            initial: media_layout::primary_display_snapshot()
                .map_err(|_| InputError::LayoutChanged)?,
            layout_version,
            keys: BTreeSet::new(),
            buttons: BTreeSet::new(),
            unicode_down: None,
        })
    }
    fn check(&mut self, deadline: Instant) -> Result<(), InputError> {
        preflight_before_post(deadline, Instant::now, || self.preflight().map(|_| ()))
    }
    fn move_to(&mut self, x: f64, y: f64, deadline: Instant) -> Result<(), InputError> {
        let (x, y) = self.initial.point(x, y).ok_or(InputError::InvalidMessage)?;
        let normalize = |v: f64, origin: f64, size: f64| {
            ((v - origin) * 65535.0 / (size - 1.0).max(1.0)).round() as i32
        };
        let dx = normalize(x, self.initial.bounds.x, self.initial.bounds.width);
        let dy = normalize(y, self.initial.bounds.y, self.initial.bounds.height);
        self.check(deadline)?;
        // Without VIRTUALDESK, absolute input maps to the primary screen only.
        post(mouse(dx, dy, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE))
    }
    fn key(&mut self, code: &str, down: bool) -> Result<(), InputError> {
        if !down && !self.keys.iter().any(|key| key == code) {
            return Ok(());
        }
        let (scan, extended) = scan_code(code).ok_or(InputError::Unsupported)?;
        post(keyboard(
            scan,
            KEYEVENTF_SCANCODE
                | if extended { KEYEVENTF_EXTENDEDKEY } else { 0 }
                | if down { 0 } else { KEYEVENTF_KEYUP },
        ))?;
        if down && !self.keys.iter().any(|key| key == code) {
            self.keys.insert(code.into());
        }
        if !down {
            self.keys.retain(|key| key != code);
        }
        Ok(())
    }
    fn button(&mut self, button: u8, down: bool) -> Result<(), InputError> {
        if !down && !self.buttons.contains(&button) {
            return Ok(());
        }
        post(mouse(0, 0, 0, button_flags(button, down)?))?;
        if down && !self.buttons.contains(&button) {
            self.buttons.insert(button);
        }
        if !down {
            self.buttons.retain(|value| *value != button);
        }
        Ok(())
    }
    fn release_unicode(&mut self) -> Result<(), InputError> {
        if let Some(unit) = self.unicode_down {
            post(keyboard(unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))?;
            self.unicode_down = None;
        }
        Ok(())
    }
}
impl InputExecutor for WindowsInputExecutor {
    fn display_snapshot(&mut self) -> Result<DisplaySnapshot, InputError> {
        let current =
            media_layout::primary_display_snapshot().map_err(|_| InputError::LayoutChanged)?;
        if current != self.initial {
            return Err(InputError::LayoutChanged);
        }
        Ok(current)
    }
    fn preflight(&mut self) -> Result<InputEnvironment, InputError> {
        interactive_desktop()?;
        self.display_snapshot()?;
        Ok(InputEnvironment {
            screen_id: "primary".into(),
            layout_version: self.layout_version,
        })
    }
    fn execute(&mut self, action: &InputAction, deadline: Instant) -> Result<(), InputError> {
        self.check(deadline)?;
        match action {
            InputAction::Move { x, y } => self.move_to(*x, *y, deadline),
            InputAction::Button { x, y, button, down } => {
                self.move_to(*x, *y, deadline)?;
                self.check(deadline)?;
                self.button(*button, *down)
            }
            InputAction::Key { code, down } => self.key(code, *down),
            InputAction::Wheel {
                x,
                y,
                delta_x,
                delta_y,
            } => {
                self.move_to(*x, *y, deadline)?;
                for (delta, flag) in [
                    (-delta_y, MOUSEEVENTF_WHEEL),
                    (*delta_x, MOUSEEVENTF_HWHEEL),
                ] {
                    if delta != 0.0 {
                        self.check(deadline)?;
                        post(mouse(0, 0, delta.round() as i32 as u32, flag))?;
                    }
                }
                Ok(())
            }
            InputAction::Text { text, .. } => {
                if !self.keys.is_empty() {
                    return Err(InputError::Unsupported);
                }
                for unit in text.encode_utf16() {
                    self.check(deadline)?;
                    post(keyboard(unit, KEYEVENTF_UNICODE))?;
                    self.unicode_down = Some(unit);
                    // Always attempt the matching up, even if the ticket expires here.
                    self.release_unicode()?;
                }
                Ok(())
            }
        }
    }
    fn release(&mut self, plan: &ReleasePlan) -> Result<(), InputError> {
        let mut failed = self.release_unicode().is_err();
        for code in &plan.keys {
            failed |= self.key(code, false).is_err();
        }
        for button in &plan.buttons {
            failed |= self.button(*button, false).is_err();
        }
        if failed {
            Err(InputError::InjectionFailed)
        } else {
            Ok(())
        }
    }
}
impl Drop for WindowsInputExecutor {
    fn drop(&mut self) {
        let plan = ReleasePlan {
            keys: self.keys.clone(),
            buttons: self.buttons.clone(),
            stop_media: false,
        };
        if self.release(&plan).is_err() {
            eprintln!("remote_input_cleanup_incomplete");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_keys_distinguish_extended_keys_and_reject_unknown_codes() {
        assert_eq!(scan_code("Enter"), Some((0x1c, false)));
        assert_eq!(scan_code("NumpadEnter"), Some((0x1c, true)));
        assert_eq!(scan_code("ControlRight"), Some((0x1d, true)));
        assert_eq!(scan_code("ControlLeft"), Some((0x1d, false)));
        assert_eq!(scan_code("ArrowLeft"), Some((0x4b, true)));
        assert_eq!(scan_code("Numpad4"), Some((0x4b, false)));
        assert_eq!(scan_code("unknown"), None);
    }
    #[test]
    fn dom_button_order_is_preserved() {
        assert_eq!(button_flags(1, true), Ok(MOUSEEVENTF_MIDDLEDOWN));
        assert_eq!(button_flags(2, false), Ok(MOUSEEVENTF_RIGHTUP));
        assert_eq!(button_flags(3, true), Err(InputError::InvalidMessage));
    }
    #[test]
    fn expired_ticket_never_reaches_windows_input() {
        let mut executor = WindowsInputExecutor {
            initial: media_layout::fixture().geometry.display_snapshot(),
            layout_version: 1,
            keys: BTreeSet::new(),
            buttons: BTreeSet::new(),
            unicode_down: None,
        };
        let deadline = Instant::now();
        assert_eq!(
            executor.execute(
                &InputAction::Key {
                    code: "KeyA".into(),
                    down: true
                },
                deadline
            ),
            Err(InputError::Expired)
        );
        assert!(executor.keys.is_empty());
        assert!(executor.buttons.is_empty());
    }

    #[test]
    #[ignore = "opens a temporary native input target; requires the interactive test desktop"]
    fn live_unicode_key_and_release() {
        use std::{ptr, thread, time::Duration};
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        struct Target(windows_sys::Win32::Foundation::HWND);
        impl Drop for Target {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        let class: Vec<u16> = "EDIT\0".encode_utf16().collect();
        let title: Vec<u16> = "NearLink input acceptance\0".encode_utf16().collect();
        let target = Target(unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE | ES_MULTILINE as u32,
                100,
                100,
                500,
                240,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            )
        });
        assert!(!target.0.is_null(), "native test target creation failed");
        unsafe {
            SetWindowTextW(target.0, [0u16].as_ptr());
            SetForegroundWindow(target.0);
        }
        fn pump() {
            let until = Instant::now() + Duration::from_millis(100);
            while Instant::now() < until {
                let mut message = unsafe { std::mem::zeroed() };
                while unsafe { PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
                    unsafe {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
        pump();
        for modifier in [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN] {
            assert_eq!(
                unsafe { GetAsyncKeyState(modifier as i32) } as u16 & 0x8000,
                0,
                "local modifier is held; abort the input test"
            );
        }
        let mut executor = WindowsInputExecutor::new_primary_screen(1).unwrap();
        let mut send = |action| {
            assert_eq!(
                unsafe { GetForegroundWindow() },
                target.0,
                "focus changed; refuse to send input to another application"
            );
            executor
                .execute(&action, Instant::now() + Duration::from_millis(500))
                .unwrap();
            pump();
        };
        send(InputAction::Text {
            text: "NearLink中文👋".into(),
            commit_id: "live-probe".into(),
        });
        send(InputAction::Key {
            code: "End".into(),
            down: true,
        });
        send(InputAction::Key {
            code: "End".into(),
            down: false,
        });
        send(InputAction::Key {
            code: "ShiftLeft".into(),
            down: true,
        });
        executor
            .release(&ReleasePlan {
                keys: ["ShiftLeft".into()].into(),
                buttons: BTreeSet::new(),
                stop_media: false,
            })
            .unwrap();
        pump();
        assert_eq!(
            unsafe { GetAsyncKeyState(VK_LSHIFT as i32) } as u16 & 0x8000,
            0,
            "forced release must clear the injected modifier"
        );
        let mut text = [0u16; 128];
        let count = unsafe { GetWindowTextW(target.0, text.as_mut_ptr(), text.len() as i32) };
        assert_eq!(
            String::from_utf16(&text[..count as usize]).unwrap(),
            "NearLink中文👋"
        );
        assert!(executor.keys.is_empty());
        assert!(executor.buttons.is_empty());
        println!("Unicode received by the native test window; key down/up completed; no owned inputs remain");
    }
}
