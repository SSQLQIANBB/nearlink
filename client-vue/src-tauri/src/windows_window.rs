use std::{error::Error, io, ptr};
use windows_sys::Win32::{
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, ICON_BIG, IMAGE_ICON, LR_SHARED, WM_SETICON,
    },
};

pub fn set_taskbar_icon(window: &tauri::WebviewWindow) -> Result<(), Box<dyn Error>> {
    let hwnd = window.hwnd()?.0;
    // tauri-build 2.6 为应用 ICO 固定使用资源 ID 32512。
    // 当前 Tao 的 set_window_icon 仅设置 ICON_SMALL，任务栏需要单独设置 ICON_BIG。
    unsafe {
        let module = GetModuleHandleW(ptr::null());
        if module.is_null() {
            return Err(io::Error::last_os_error().into());
        }
        let icon = LoadImageW(
            module,
            32512usize as *const u16,
            IMAGE_ICON,
            256,
            256,
            LR_SHARED,
        );
        if icon.is_null() {
            return Err(io::Error::last_os_error().into());
        }
        // LR_SHARED 图标由 Windows 管理，保持到进程退出，不手动 DestroyIcon。
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize);
    }
    Ok(())
}

/// Keep the native caption and controls while matching the call surface (#0b1220).
pub fn set_call_window_colors(window: &tauri::WebviewWindow) -> Result<(), Box<dyn Error>> {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
    };
    let hwnd = window.hwnd()?.0;
    // COLORREF uses 0x00BBGGRR, unlike CSS RGB.
    for (attribute, value) in [
        (DWMWA_USE_IMMERSIVE_DARK_MODE, 1u32),
        (DWMWA_CAPTION_COLOR, 0x0020120b),
        (DWMWA_TEXT_COLOR, 0x00fcfaf8),
    ] {
        let result = unsafe {
            DwmSetWindowAttribute(hwnd, attribute as u32, (&value as *const u32).cast(), 4)
        };
        if result < 0 {
            return Err(format!("设置通话标题栏颜色失败: {result:#x}").into());
        }
    }
    Ok(())
}
