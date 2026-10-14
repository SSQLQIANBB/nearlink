//! Primary-screen BGRA capture. Construction does not grant session authority.
//! The media engine must only create this source after native consent and lease.
#![allow(dead_code)]
use super::{
    media_layout::{self, DisplaySnapshot},
    platform,
};
use std::{ffi::c_void, ptr};
use windows_sys::Win32::Graphics::Gdi::*;

type CaptureResult<T> = Result<T, &'static str>;

#[link(name = "user32")]
extern "system" {
    fn SetThreadDpiAwarenessContext(context: *mut c_void) -> *mut c_void;
}
struct PhysicalPixels(*mut c_void);
impl PhysicalPixels {
    fn enter() -> CaptureResult<Self> {
        // Per-monitor-v2 on this capture thread only; restore the caller's context.
        let previous = unsafe { SetThreadDpiAwarenessContext(-4isize as *mut c_void) };
        if previous.is_null() {
            return Err("REMOTE_CAPTURE_DPI_UNAVAILABLE");
        }
        Ok(Self(previous))
    }
}
impl Drop for PhysicalPixels {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}

pub(super) struct PrimaryCapture {
    display: DisplaySnapshot,
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    pixels: *mut c_void,
    length: usize,
}
impl PrimaryCapture {
    pub fn new() -> CaptureResult<Self> {
        let _dpi = PhysicalPixels::enter()?;
        if !platform::interactive_desktop() {
            return Err("REMOTE_CAPTURE_DESKTOP_UNAVAILABLE");
        }
        let display = media_layout::primary_display_snapshot()?;
        let mut source = Self {
            display,
            screen: ptr::null_mut(),
            memory: ptr::null_mut(),
            bitmap: ptr::null_mut(),
            previous: ptr::null_mut(),
            pixels: ptr::null_mut(),
            length: display.pixels.width as usize * display.pixels.height as usize * 4,
        };
        source.screen = unsafe { GetDC(ptr::null_mut()) };
        if source.screen.is_null() {
            return Err("REMOTE_CAPTURE_UNAVAILABLE");
        }
        source.memory = unsafe { CreateCompatibleDC(source.screen) };
        if source.memory.is_null() {
            return Err("REMOTE_CAPTURE_UNAVAILABLE");
        }
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = display.pixels.width as i32;
        info.bmiHeader.biHeight = -(display.pixels.height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        source.bitmap = unsafe {
            CreateDIBSection(
                source.screen,
                &info,
                DIB_RGB_COLORS,
                &mut source.pixels,
                ptr::null_mut(),
                0,
            )
        };
        if source.bitmap.is_null() || source.pixels.is_null() {
            return Err("REMOTE_CAPTURE_UNAVAILABLE");
        }
        source.previous = unsafe { SelectObject(source.memory, source.bitmap) };
        if source.previous.is_null() || source.previous as isize == -1 {
            source.previous = ptr::null_mut();
            return Err("REMOTE_CAPTURE_UNAVAILABLE");
        }
        Ok(source)
    }
    pub fn display(&self) -> DisplaySnapshot {
        self.display
    }
    pub fn capture(&mut self) -> CaptureResult<&[u8]> {
        let _dpi = PhysicalPixels::enter()?;
        if !platform::interactive_desktop() {
            return Err("REMOTE_CAPTURE_DESKTOP_UNAVAILABLE");
        }
        if media_layout::primary_display_snapshot()? != self.display {
            return Err("REMOTE_MEDIA_LAYOUT_CHANGED");
        }
        if unsafe {
            BitBlt(
                self.memory,
                0,
                0,
                self.display.pixels.width as i32,
                self.display.pixels.height as i32,
                self.screen,
                self.display.bounds.x as i32,
                self.display.bounds.y as i32,
                SRCCOPY | CAPTUREBLT,
            )
        } == 0
        {
            return Err("REMOTE_CAPTURE_FAILED");
        }
        // GDI batches writes; synchronize before reading the DIB memory.
        if unsafe { GdiFlush() } == 0 {
            return Err("REMOTE_CAPTURE_FAILED");
        }
        if !platform::interactive_desktop() {
            return Err("REMOTE_CAPTURE_DESKTOP_UNAVAILABLE");
        }
        if media_layout::primary_display_snapshot()? != self.display {
            return Err("REMOTE_MEDIA_LAYOUT_CHANGED");
        }
        Ok(unsafe { std::slice::from_raw_parts(self.pixels.cast(), self.length) })
    }
}
impl Drop for PrimaryCapture {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_null() {
                SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.memory.is_null() {
                DeleteDC(self.memory);
            }
            if !self.screen.is_null() {
                ReleaseDC(ptr::null_mut(), self.screen);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "captures the interactive Windows desktop; run explicitly on the test computer"]
    fn live_capture_and_release() {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> *mut c_void;
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetGuiResources(process: *mut c_void, flags: u32) -> u32;
        }
        let resources = || unsafe { GetGuiResources(GetCurrentProcess(), 0) };
        let before = resources();
        for _ in 0..10 {
            let mut source = PrimaryCapture::new().unwrap();
            let display = source.display();
            let frame = source.capture().unwrap();
            assert_eq!(
                frame.len(),
                display.pixels.width as usize * display.pixels.height as usize * 4
            );
            assert!(frame
                .chunks_exact(4)
                .any(|pixel| pixel[..3].iter().any(|value| *value != 0)));
            println!(
                "Captured {}x{} BGRA primary screen; pixels remain in memory only",
                display.pixels.width, display.pixels.height
            );
        }
        assert_eq!(resources(), before, "capture must release all GDI handles");
    }
}
