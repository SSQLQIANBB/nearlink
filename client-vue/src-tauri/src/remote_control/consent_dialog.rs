//! Decisions and the checkbox originate only in the native dialog, never IPC.
use super::identity::Decision;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Choice {
    pub decision: Decision,
    pub remember: bool,
}
fn choice(button: isize, control: bool, checked: bool) -> Choice {
    let decision = match button {
        1001 => Decision::View,
        1002 if control => Decision::Control,
        _ => Decision::Reject,
    };
    Choice {
        decision,
        remember: checked && decision != Decision::Reject,
    }
}
pub(super) struct Prompt {
    pub controller_account: u64,
    pub details: String,
    pub control: bool,
    pub deadline: std::time::Instant,
}
#[cfg(target_os = "macos")]
#[path = "consent_panel.rs"]
mod panel;
#[cfg(target_os = "macos")]
pub(super) fn show(window: &tauri::WebviewWindow, prompt: Prompt) -> Result<Choice, &'static str> {
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::NSWindow;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let parent = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let mtm = MainThreadMarker::new().ok_or("REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
                let pointer = parent
                    .ns_window()
                    .map_err(|_| "REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
                let parent = unsafe { Retained::retain(pointer.cast::<NSWindow>()) }
                    .ok_or("REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
                Ok(panel::show(mtm, &parent, prompt))
            })();
            let _ = tx.send(result);
        })
        .map_err(|_| "REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
    rx.recv().map_err(|_| "REMOTE_CONSENT_WINDOW_UNAVAILABLE")?
}
#[cfg(not(target_os = "macos"))]
pub(super) fn show(window: &tauri::WebviewWindow, prompt: Prompt) -> Result<Choice, &'static str> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
    // Host release is currently macOS-only; retain explicit native confirmation
    // elsewhere and never infer a remembered choice without a native checkbox.
    let control = prompt.control;
    let selected = window
        .app_handle()
        .dialog()
        .message(prompt.details)
        .parent(window)
        .title("NearLink · 本机远程协助确认")
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "拒绝".into(),
            if control {
                "允许控制".into()
            } else {
                "允许查看".into()
            },
            "取消".into(),
        ))
        .blocking_show_with_result();
    let decision = match selected {
        MessageDialogResult::Custom(ref s) if s == "允许控制" && control => Decision::Control,
        MessageDialogResult::Custom(ref s) if s == "允许查看" => Decision::View,
        _ => Decision::Reject,
    };
    Ok(Choice {
        decision,
        remember: false,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkbox_never_remembers_reject_cancel_escape_or_unknown_result() {
        for control in [false, true] {
            for checked in [false, true] {
                for button in [1000, 1003, -1000, -1001, 0, 99] {
                    assert_eq!(
                        choice(button, control, checked),
                        Choice {
                            decision: Decision::Reject,
                            remember: false
                        }
                    );
                }
            }
        }
        assert_eq!(
            choice(1002, false, true),
            Choice {
                decision: Decision::Reject,
                remember: false
            }
        );
        assert_eq!(
            choice(1001, false, true),
            Choice {
                decision: Decision::View,
                remember: true
            }
        );
        assert_eq!(
            choice(1002, true, true),
            Choice {
                decision: Decision::Control,
                remember: true
            }
        );
        assert_eq!(
            choice(1001, true, false),
            Choice {
                decision: Decision::View,
                remember: false
            }
        );
    }
}

// Development-only visual harness. It returns a Choice but has no identity
// store, signing keys, network, capture, input, or remembered-consent writes.
#[cfg(all(target_os = "macos", feature = "remote-control-harness"))]
pub(super) fn preview(
    mtm: objc2::MainThreadMarker,
    parent: &objc2_app_kit::NSWindow,
    prompt: Prompt,
) -> Choice {
    panel::show(mtm, parent, prompt)
}
