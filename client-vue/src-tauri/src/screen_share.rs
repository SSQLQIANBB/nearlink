//! User-selected screen sharing, separate from remote-control authorization.
use image::{codecs::jpeg::JpegEncoder, DynamicImage};
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use tauri::PhysicalSize;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

type Result<T> = std::result::Result<T, String>;
const EDGES: [&str; 4] = ["share-top", "share-bottom", "share-left", "share-right"];

#[derive(Clone)]
enum Source {
    Display(u32),
    Window(u32, u32),
}
enum NativeSource {
    Display(xcap::Monitor),
    Window(xcap::Window, u32),
}
#[derive(Clone, Copy, PartialEq)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}
impl Source {
    // Resolve native handles on the capture thread; Monitor is deliberately not Send.
    fn resolve(&self) -> Result<NativeSource> {
        match self {
            Self::Display(id) => xcap::Monitor::all()
                .map_err(err)?
                .into_iter()
                .find(|m| m.id().ok() == Some(*id))
                .map(NativeSource::Display)
                .ok_or("显示器已断开".into()),
            Self::Window(id, pid) => xcap::Window::all()
                .map_err(err)?
                .into_iter()
                .find(|w| w.id().ok() == Some(*id) && w.pid().ok() == Some(*pid))
                .map(|w| NativeSource::Window(w, *pid))
                .ok_or("共享窗口已关闭或最小化".into()),
        }
    }
    fn bounds(&self) -> Result<Bounds> {
        self.resolve()?.bounds()
    }
    fn capture(&self, width: u32) -> Result<Vec<u8>> {
        self.resolve()?.capture(width)
    }
}
impl NativeSource {
    fn bounds(&self) -> Result<Bounds> {
        let (x, y, width, height) = match self {
            Self::Display(m) => (m.x(), m.y(), m.width(), m.height()),
            Self::Window(w, pid) => {
                if w.pid().map_err(err)? != *pid || w.is_minimized().map_err(err)? {
                    return Err("共享窗口已关闭或最小化".into());
                }
                (w.x(), w.y(), w.width(), w.height())
            }
        };
        let bounds = Bounds {
            x: x.map_err(err)?,
            y: y.map_err(err)?,
            width: width.map_err(err)?,
            height: height.map_err(err)?,
        };
        if bounds.width == 0 || bounds.height == 0 {
            return Err("共享区域不可用".into());
        }
        Ok(bounds)
    }
    fn capture(&self, width: u32) -> Result<Vec<u8>> {
        self.bounds()?;
        let pixels = match self {
            Self::Display(m) => m.capture_image(),
            Self::Window(w, _) => w.capture_image(),
        }
        .map_err(err)?;
        let image = DynamicImage::ImageRgba8(pixels);
        let height = ((image.height() as u64 * width as u64 / image.width() as u64) as u32).max(1);
        let image = image.thumbnail(width, height).to_rgb8();
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 85)
            .encode_image(&image)
            .map_err(err)?;
        Ok(bytes)
    }
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn media(window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() != "media-call" {
        return Err("仅通话窗口可以发起共享".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    id: String,
    name: String,
    app: String,
    kind: &'static str,
}
struct Active {
    token: u64,
    source: Source,
    bounds: Option<Bounds>,
}
#[derive(Default)]
struct State {
    catalog: HashMap<String, Source>,
    active: Option<Active>,
    next_token: u64,
}
#[derive(Default)]
pub struct ScreenShareState {
    inner: Mutex<State>,
    lifecycle: tauri::async_runtime::Mutex<()>,
}

#[tauri::command]
pub async fn screen_share_sources(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Vec<SourceInfo>> {
    media(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut catalog = HashMap::new();
        let mut entries = Vec::new();
        for (index, monitor) in xcap::Monitor::all().map_err(err)?.into_iter().enumerate() {
            let id = format!("display:{}", monitor.id().map_err(err)?);
            entries.push(SourceInfo {
                id: id.clone(),
                name: format!("桌面 {}", index + 1),
                app: "桌面".into(),
                kind: "display",
            });
            catalog.insert(id, Source::Display(monitor.id().map_err(err)?));
        }
        for w in xcap::Window::all().map_err(err)? {
            // Windows can disappear while enumeration is in progress.
            let Ok(pid) = w.pid() else { continue };
            if pid == std::process::id() || w.is_minimized().unwrap_or(true) {
                continue;
            }
            let (Ok(id), Ok(title), Ok(app_name)) = (w.id(), w.title(), w.app_name()) else {
                continue;
            };
            if title.trim().is_empty() {
                continue;
            }
            let key = format!("window:{id}:{pid}");
            entries.push(SourceInfo {
                id: key.clone(),
                name: title,
                app: app_name,
                kind: "window",
            });
            catalog.insert(key, Source::Window(id, pid));
        }
        app.state::<ScreenShareState>()
            .inner
            .lock()
            .unwrap()
            .catalog = catalog;
        Ok(entries)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn screen_share_preview(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<tauri::ipc::Response> {
    media(&window)?;
    let source = app
        .state::<ScreenShareState>()
        .inner
        .lock()
        .unwrap()
        .catalog
        .get(&id)
        .cloned()
        .ok_or("共享源已失效，请刷新列表")?;
    let bytes = tauri::async_runtime::spawn_blocking(move || source.capture(320))
        .await
        .map_err(err)??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn screen_share_start(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<u64> {
    media(&window)?;
    let state = app.state::<ScreenShareState>();
    let _lifecycle = state.lifecycle.lock().await;
    let mut state = state.inner.lock().unwrap();
    if state.active.is_some() {
        return Err("已有屏幕共享正在进行".into());
    }
    let source = state
        .catalog
        .get(&id)
        .cloned()
        .ok_or("共享源已失效，请刷新列表")?;
    source.bounds()?;
    state.next_token += 1;
    let token = state.next_token;
    state.active = Some(Active {
        token,
        source,
        bounds: None,
    });
    Ok(token)
}

fn source_for(app: &tauri::AppHandle, token: u64) -> Result<Source> {
    app.state::<ScreenShareState>()
        .inner
        .lock()
        .unwrap()
        .active
        .as_ref()
        .filter(|a| a.token == token)
        .map(|a| a.source.clone())
        .ok_or("共享已结束".into())
}

fn overlay_window<'a>(
    app: &'a tauri::AppHandle,
    label: &str,
    url: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()));
    // Windows share WebView2's default profile, so browser arguments must agree,
    // including the remote-debugging settings used by native CI.
    if let Some(args) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.as_deref())
    {
        builder = builder.additional_browser_args(args);
    }
    builder
}

fn position_edges(app: &tauri::AppHandle, b: Bounds) -> Result<()> {
    let thickness = 4;
    let rectangles = [
        (b.x, b.y, b.width, thickness),
        (
            b.x,
            b.y + b.height as i32 - thickness as i32,
            b.width,
            thickness,
        ),
        (b.x, b.y, thickness, b.height),
        (
            b.x + b.width as i32 - thickness as i32,
            b.y,
            thickness,
            b.height,
        ),
    ];
    for (label, (x, y, width, height)) in EDGES.iter().zip(rectangles) {
        if let Some(window) = app.get_webview_window(label) {
            #[cfg(target_os = "windows")]
            {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE,
                    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW,
                    WS_OVERLAPPEDWINDOW, WS_POPUP,
                };
                let hwnd = window.hwnd().map_err(err)?.0;
                // Tao retains normal-window styles even without decorations. Windows
                // expands these thin edges to 71px at 200% DPI while system-menu and
                // caption controls remain. Passive borders must use popup styles only.
                unsafe {
                    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                    if SetWindowLongPtrW(
                        hwnd,
                        GWL_STYLE,
                        (style & !(WS_OVERLAPPEDWINDOW as isize)) | WS_POPUP as isize,
                    ) == 0
                        || SetWindowPos(
                            hwnd,
                            std::ptr::null_mut(),
                            x,
                            y,
                            width as i32,
                            height as i32,
                            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
                        ) == 0
                    {
                        return Err(err(std::io::Error::last_os_error()));
                    }
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                window
                    .set_size(PhysicalSize::new(width, height))
                    .map_err(err)?;
                window
                    .set_position(PhysicalPosition::new(x, y))
                    .map_err(err)?;
            }
            // CoreGraphics window bounds use points, unlike Windows physical pixels.
            #[cfg(target_os = "macos")]
            {
                window
                    .set_position(tauri::LogicalPosition::new(x, y))
                    .map_err(err)?;
                window
                    .set_size(tauri::LogicalSize::new(width, height))
                    .map_err(err)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn screen_share_frame(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    token: u64,
    smooth: bool,
) -> Result<tauri::ipc::Response> {
    media(&window)?;
    let source = source_for(&app, token)?;
    let (bytes, bounds) = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(if smooth { 50 } else { 100 });
        let source = source.resolve()?;
        let frame = (
            source.capture(if smooth { 1280 } else { 1600 })?,
            source.bounds()?,
        );
        std::thread::sleep(deadline.saturating_duration_since(std::time::Instant::now()));
        Ok::<_, String>(frame)
    })
    .await
    .map_err(err)??;
    // A late frame must never revive overlays after stop or a subsequent share.
    let state = app.state::<ScreenShareState>();
    let _lifecycle = state.lifecycle.lock().await;
    let changed = {
        let mut state = state.inner.lock().unwrap();
        let active = state
            .active
            .as_mut()
            .filter(|a| a.token == token)
            .ok_or("共享已结束")?;
        let changed = active.bounds != Some(bounds);
        active.bounds = Some(bounds);
        changed
    };
    if changed {
        position_edges(&app, bounds)?;
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn screen_share_present(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    token: u64,
) -> Result<()> {
    media(&window)?;
    // Async serialization leaves the UI thread free to build/destroy native windows.
    let state = app.state::<ScreenShareState>();
    let _lifecycle = state.lifecycle.lock().await;
    let bounds = source_for(&app, token)?.bounds()?;
    let result = (|| {
        for label in EDGES {
            // A tiny static document avoids mounting four copies of the Vue application.
            let edge = overlay_window(&app, label, "share-border.html")
                .title("共享区域")
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .shadow(false)
                .content_protected(true)
                .background_color(tauri::window::Color(0, 205, 130, 255))
                .min_inner_size(1.0, 1.0)
                .inner_size(4.0, 4.0)
                .build()
                .map_err(err)?;
            edge.set_ignore_cursor_events(true).map_err(err)?;
        }
        position_edges(&app, bounds)?;
        let toolbar = overlay_window(
            &app,
            "share-toolbar",
            &format!("index.html?share-overlay=toolbar&token={token}"),
        )
        .title("正在共享屏幕")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .shadow(false)
        .content_protected(true)
        .inner_size(400.0, 44.0)
        .build()
        .map_err(err)?;
        let monitor = window
            .current_monitor()
            .map_err(err)?
            .ok_or("找不到当前显示器")?;
        let scale = monitor.scale_factor();
        toolbar
            .set_position(PhysicalPosition::new(
                monitor.position().x + (monitor.size().width as i32 - (400.0 * scale) as i32) / 2,
                monitor.position().y + 8,
            ))
            .map_err(err)?;
        // Windows edges are shown by SetWindowPos so Tao does not restore normal-window styles.
        #[cfg(not(target_os = "windows"))]
        for label in EDGES {
            app.get_webview_window(label).unwrap().show().map_err(err)?;
        }
        toolbar.show().map_err(err)?;
        window.hide().map_err(err)?;
        Ok(())
    })();
    if result.is_err() {
        stop_locked(&app, token);
    }
    result
}

fn stop_locked(app: &tauri::AppHandle, token: u64) {
    let active = {
        let state = app.state::<ScreenShareState>();
        let mut state = state.inner.lock().unwrap();
        if state.active.as_ref().map(|a| a.token) != Some(token) {
            return;
        }
        state.active.take()
    };
    if let Some(active) = active {
        for label in EDGES.into_iter().chain(["share-toolbar"]) {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.destroy();
            }
        }
        if let Some(window) = app.get_webview_window("media-call") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.emit("desktop-share-stop", active.token);
        }
    }
}

#[tauri::command]
pub async fn screen_share_stop(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    token: u64,
) -> Result<()> {
    if !matches!(window.label(), "media-call" | "share-toolbar") {
        return Err("无权停止共享".into());
    }
    let state = app.state::<ScreenShareState>();
    let _lifecycle = state.lifecycle.lock().await;
    stop_locked(&app, token);
    Ok(())
}

pub fn stop_on_window_close(app: &tauri::AppHandle) {
    let token = app
        .state::<ScreenShareState>()
        .inner
        .lock()
        .unwrap()
        .active
        .as_ref()
        .map(|a| a.token);
    if let Some(token) = token {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<ScreenShareState>();
            let _lifecycle = state.lifecycle.lock().await;
            stop_locked(&app, token);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "captures the interactive desktop in memory; run explicitly on a desktop"]
    fn selected_sources_capture_and_disappeared_source_fails() {
        let monitor = xcap::Monitor::all().unwrap().remove(0);
        let source = Source::Display(monitor.id().unwrap());
        let bounds = source.bounds().unwrap();
        assert!(bounds.width > 0 && bounds.height > 0);
        let jpeg = source.capture(320).unwrap();
        let decoded = image::load_from_memory(&jpeg).unwrap();
        assert!(decoded.width() <= 320);
        assert!(decoded.height() > 0);
        if let Some(window) = xcap::Window::all().unwrap().into_iter().find(|w| {
            w.pid().ok() != Some(std::process::id()) && w.is_minimized().ok() == Some(false)
        }) {
            let source = Source::Window(window.id().unwrap(), window.pid().unwrap());
            let jpeg = source.capture(320).unwrap();
            assert!(image::load_from_memory(&jpeg).unwrap().width() <= 320);
        }
        assert!(Source::Window(0, 0).capture(320).is_err());
    }
}
