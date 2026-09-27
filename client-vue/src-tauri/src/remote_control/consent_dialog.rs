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
#[cfg(target_os = "macos")]
pub(super) fn show(
    window: &tauri::WebviewWindow,
    message: String,
    control: bool,
) -> Result<Choice, &'static str> {
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{NSAlert, NSApplication, NSWindow};
    use objc2_foundation::NSString;
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
                let alert = NSAlert::new(mtm);
                alert.setMessageText(&NSString::from_str("ToDesk · 本机远程协助确认"));
                alert.setInformativeText(&NSString::from_str(&message));
                // Return rejects; Escape/cancel/window-close never becomes approval.
                alert.addButtonWithTitle(&NSString::from_str("拒绝"));
                alert.addButtonWithTitle(&NSString::from_str(if control {
                    "仅允许查看"
                } else {
                    "允许查看"
                }));
                if control {
                    alert.addButtonWithTitle(&NSString::from_str("允许控制"));
                }
                let cancel = alert.addButtonWithTitle(&NSString::from_str("取消"));
                cancel.setKeyEquivalent(&NSString::from_str("\u{1b}"));
                alert.setShowsSuppressionButton(true);
                let checkbox = alert
                    .suppressionButton()
                    .ok_or("REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
                checkbox.setTitle(&NSString::from_str(
                    "不再提示（记住对此账号的本次允许范围）",
                ));
                checkbox.setState(0);
                let completion = block2::StackBlock::new(move |result| {
                    NSApplication::sharedApplication(mtm).stopModalWithCode(result);
                });
                alert.beginSheetModalForWindow_completionHandler(&parent, Some(&completion));
                let response = alert.runModal();
                Ok(choice(response, control, checkbox.state() == 1))
            })();
            let _ = tx.send(result);
        })
        .map_err(|_| "REMOTE_CONSENT_WINDOW_UNAVAILABLE")?;
    rx.recv().map_err(|_| "REMOTE_CONSENT_WINDOW_UNAVAILABLE")?
}
#[cfg(not(target_os = "macos"))]
pub(super) fn show(
    window: &tauri::WebviewWindow,
    message: String,
    control: bool,
) -> Result<Choice, &'static str> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
    // Host release is currently macOS-only; retain explicit native confirmation
    // elsewhere and never infer a remembered choice without a native checkbox.
    let selected = window
        .app_handle()
        .dialog()
        .message(message)
        .parent(window)
        .title("ToDesk · 本机远程协助确认")
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
