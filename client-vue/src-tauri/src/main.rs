#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod remote_control;
mod screen_share;
#[cfg(target_os = "windows")]
mod windows_window;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_window_state::StateFlags;

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let context = tauri::generate_context!();
    #[cfg(target_os = "windows")]
    let context = {
        let mut context = context;
        context
            .config_mut()
            .app
            .windows
            .iter_mut()
            .find(|window| window.label == "main")
            .expect("missing main window config")
            .decorations = false;
        context
    };
    tauri::Builder::default()
        .manage(remote_control::RemoteControlState::default())
        .manage(screen_share::ScreenShareState::default())
        .invoke_handler(tauri::generate_handler![
            screen_share::screen_share_sources,
            screen_share::screen_share_preview,
            screen_share::screen_share_start,
            screen_share::screen_share_frame,
            screen_share::screen_share_present,
            screen_share::screen_share_stop,
            remote_control::remote_control_capabilities,
            remote_control::remote_control_open_permission_settings,
            remote_control::remote_control_stop,
            remote_control::remote_control_register_device,
            remote_control::remote_control_identify_device,
            remote_control::remote_control_bind_controller,
            remote_control::remote_control_confirm_request,
            remote_control::remote_control_clear_remembered_approvals,
            remote_control::remote_control_list_remembered_approvals,
            remote_control::remote_control_remove_remembered_approval,
            remote_control::remote_control_reset_identity,
            remote_control::remote_control_presence,
            remote_control::remote_control_start_host,
            remote_control::remote_control_host_command,
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app)
        }))
        .plugin({
            let builder = tauri_plugin_window_state::Builder::default()
                // 托盘退出时窗口可能隐藏或最小化，重新启动必须能看到主窗口。
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
            // 开发启动使用配置尺寸，避免历史窗口状态覆盖正在调整的默认布局。
            #[cfg(debug_assertions)]
            let builder = builder.skip_initial_state("main");
            builder.build()
        })
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            windows_window::set_taskbar_icon(
                &app.get_webview_window("main").expect("missing main window"),
            )?;
            let open = MenuItem::with_id(app, "open", "打开 NearLink", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 NearLink", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("missing app icon").clone())
                .tooltip(format!(
                    "NearLink 内测版 {} · 关闭窗口后仍在后台运行",
                    env!("CARGO_PKG_VERSION")
                ))
                .menu(&menu)
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => {
                        let _ = app.state::<remote_control::RemoteControlState>().stop();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "media-call"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                #[cfg(target_os = "windows")]
                if let Some(window) = webview.app_handle().get_webview_window("media-call") {
                    if let Err(error) = windows_window::set_call_window_colors(&window) {
                        eprintln!("{error}");
                    }
                }
                screen_share::stop_on_window_close(webview.app_handle());
            }
            // 主页面刷新会重建信令连接，销毁旧媒体窗口，避免遗留采集资源。
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                for label in ["image-preview", "media-call"] {
                    if let Some(window) = webview.app_handle().get_webview_window(label) {
                        let _ = window.destroy();
                    }
                }
            }
        })
        .on_window_event(|window, event| {
            if matches!(window.label(), "media-call" | "share-toolbar")
                && matches!(event, WindowEvent::Destroyed)
            {
                screen_share::stop_on_window_close(window.app_handle());
            }
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 保留页面与媒体流；只有成功隐藏后才阻止关闭。
                if window.hide().is_ok() {
                    api.prevent_close();
                }
            }
        })
        .build(context)
        .expect("failed to build NearLink desktop")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                let _ = app.state::<remote_control::RemoteControlState>().stop();
            }
            // macOS 关闭窗口后，点击 Dock 图标重新显示主窗口。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
