//! Captured-video geometry is authenticated by the inherited-pipe reader, then
//! bound to an independent native display snapshot before any input can arm.
use serde::{Deserialize, Serialize};
use serde_json::Value;

type LayoutResult<T> = Result<T, &'static str>;
const MAX_SIZE: u32 = 16_384;
const MAX_COORDINATE: f64 = 1_000_000.0;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct PixelSize {
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MediaGeometry {
    pub display_id: u32,
    pub coordinate_space: String,
    pub display_bounds: Rect,
    pub display_pixels: PixelSize,
    pub rotation_degrees: u16,
    pub encoded_size: PixelSize,
    pub content_rect: Rect,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MediaLayout {
    pub screen_id: String,
    pub layout_version: u64,
    pub geometry: MediaGeometry,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct DisplaySnapshot {
    pub display_id: u32,
    pub bounds: Rect,
    /// Physical pixels, oriented to the same axes as bounds.
    pub pixels: PixelSize,
    pub rotation_degrees: u16,
}
fn size_valid(size: PixelSize) -> bool {
    (1..=MAX_SIZE).contains(&size.width) && (1..=MAX_SIZE).contains(&size.height)
}
impl DisplaySnapshot {
    pub fn validate(self) -> LayoutResult<Self> {
        if self.display_id == 0
            || !size_valid(self.pixels)
            || ![0, 90, 180, 270].contains(&self.rotation_degrees)
            || ![
                self.bounds.x,
                self.bounds.y,
                self.bounds.width,
                self.bounds.height,
            ]
            .iter()
            .all(|v| v.is_finite())
            || self.bounds.x.abs() > MAX_COORDINATE
            || self.bounds.y.abs() > MAX_COORDINATE
            || !(1.0..=MAX_SIZE as f64).contains(&self.bounds.width)
            || !(1.0..=MAX_SIZE as f64).contains(&self.bounds.height)
        {
            return Err("REMOTE_MEDIA_LAYOUT_INVALID");
        }
        Ok(self)
    }
    pub fn point(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        if !x.is_finite()
            || !y.is_finite()
            || !(0.0..=1.0).contains(&x)
            || !(0.0..=1.0).contains(&y)
        {
            return None;
        }
        let axis = |origin: f64, extent: f64, pixels: u32, normal: f64| {
            origin + (normal * extent).min(extent - extent / f64::from(pixels))
        };
        Some((
            axis(self.bounds.x, self.bounds.width, self.pixels.width, x),
            axis(self.bounds.y, self.bounds.height, self.pixels.height, y),
        ))
    }
}
impl MediaGeometry {
    pub fn display_snapshot(&self) -> DisplaySnapshot {
        DisplaySnapshot {
            display_id: self.display_id,
            bounds: self.display_bounds,
            pixels: self.display_pixels,
            rotation_degrees: self.rotation_degrees,
        }
    }
}
impl MediaLayout {
    pub fn parse(value: Value) -> LayoutResult<Self> {
        let layout: Self =
            serde_json::from_value(value).map_err(|_| "REMOTE_MEDIA_LAYOUT_INVALID")?;
        layout.validate()?;
        Ok(layout)
    }
    pub fn validate(&self) -> LayoutResult<()> {
        if self.screen_id != "primary"
            || self.layout_version == 0
            || self.layout_version > 9_007_199_254_740_991
            || !matches!(self.geometry.coordinate_space.as_str(), "quartz-global-logical" | "windows-desktop-physical")
        {
            return Err("REMOTE_MEDIA_LAYOUT_INVALID");
        }
        self.geometry.display_snapshot().validate()?;
        let r = self.geometry.content_rect;
        let size = self.geometry.encoded_size;
        if !size_valid(size)
            || ![r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
            || r.x < 0.0
            || r.y < 0.0
            || r.width <= 0.0
            || r.height <= 0.0
            || r.x + r.width > f64::from(size.width)
            || r.y + r.height > f64::from(size.height)
        {
            return Err("REMOTE_MEDIA_LAYOUT_INVALID");
        }
        Ok(())
    }
}
#[derive(Default)]
pub(super) struct LayoutTracker {
    layout: Option<MediaLayout>,
    failed: bool,
}
impl LayoutTracker {
    pub fn observe(&mut self, value: Value) -> LayoutResult<()> {
        if self.failed {
            return Err("REMOTE_MEDIA_LAYOUT_CHANGED");
        }
        match MediaLayout::parse(value) {
            Ok(next) if self.layout.as_ref().is_none_or(|old| *old == next) => {
                self.layout = Some(next);
                Ok(())
            }
            _ => {
                self.invalidate();
                Err("REMOTE_MEDIA_LAYOUT_CHANGED")
            }
        }
    }
    pub fn invalidate(&mut self) {
        self.failed = true;
    }
    pub fn snapshot(&self) -> LayoutResult<Option<MediaLayout>> {
        if self.failed {
            Err("REMOTE_MEDIA_LAYOUT_CHANGED")
        } else {
            Ok(self.layout.clone())
        }
    }
}

/// Display mode dimensions are not assumed to have already been rotated. Match
/// them to the current logical bounds, then orient the physical pixels likewise.
pub(super) fn oriented_mode_pixels(
    bounds: Rect,
    mode_points: PixelSize,
    mode_pixels: PixelSize,
) -> LayoutResult<PixelSize> {
    if !size_valid(mode_points) || !size_valid(mode_pixels) {
        return Err("REMOTE_MEDIA_LAYOUT_INVALID");
    }
    if bounds.width == f64::from(mode_points.width)
        && bounds.height == f64::from(mode_points.height)
    {
        Ok(mode_pixels)
    } else if bounds.width == f64::from(mode_points.height)
        && bounds.height == f64::from(mode_points.width)
    {
        Ok(PixelSize {
            width: mode_pixels.height,
            height: mode_pixels.width,
        })
    } else {
        Err("REMOTE_MEDIA_LAYOUT_INVALID")
    }
}
#[cfg(target_os = "macos")]
pub(super) fn primary_display_snapshot() -> LayoutResult<DisplaySnapshot> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct Bounds {
        origin: Point,
        size: Size,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> Bounds;
        fn CGDisplayRotation(display: u32) -> f64;
        fn CGDisplayCopyDisplayMode(display: u32) -> *const c_void;
        fn CGDisplayModeGetWidth(mode: *const c_void) -> usize;
        fn CGDisplayModeGetHeight(mode: *const c_void) -> usize;
        fn CGDisplayModeGetPixelWidth(mode: *const c_void) -> usize;
        fn CGDisplayModeGetPixelHeight(mode: *const c_void) -> usize;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
    }
    // Read-only CoreGraphics calls: no AX/TCC prompt and no event construction.
    let display_id = unsafe { CGMainDisplayID() };
    let raw = unsafe { CGDisplayBounds(display_id) };
    let bounds = Rect {
        x: raw.origin.x,
        y: raw.origin.y,
        width: raw.size.width,
        height: raw.size.height,
    };
    let rotation = unsafe { CGDisplayRotation(display_id) };
    if ![0.0, 90.0, 180.0, 270.0].contains(&rotation) {
        return Err("REMOTE_MEDIA_LAYOUT_INVALID");
    }
    let mode = unsafe { CGDisplayCopyDisplayMode(display_id) };
    if mode.is_null() {
        return Err("REMOTE_MEDIA_LAYOUT_INVALID");
    }
    let points = (unsafe { CGDisplayModeGetWidth(mode) }, unsafe {
        CGDisplayModeGetHeight(mode)
    });
    let pixels = (unsafe { CGDisplayModeGetPixelWidth(mode) }, unsafe {
        CGDisplayModeGetPixelHeight(mode)
    });
    unsafe { CFRelease(mode) };
    let size = |(w, h): (usize, usize)| -> LayoutResult<PixelSize> {
        Ok(PixelSize {
            width: w.try_into().map_err(|_| "REMOTE_MEDIA_LAYOUT_INVALID")?,
            height: h.try_into().map_err(|_| "REMOTE_MEDIA_LAYOUT_INVALID")?,
        })
    };
    let snapshot = DisplaySnapshot {
        display_id,
        bounds,
        pixels: oriented_mode_pixels(bounds, size(points)?, size(pixels)?)?,
        rotation_degrees: rotation as u16,
    }
    .validate()?;
    if unsafe { CGMainDisplayID() } != display_id {
        return Err("REMOTE_MEDIA_LAYOUT_CHANGED");
    }
    Ok(snapshot)
}
#[cfg(target_os = "windows")]
pub(super) fn primary_display_snapshot() -> LayoutResult<DisplaySnapshot> {
    use windows_sys::Win32::Graphics::Gdi::{EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS};
    let mut mode: DEVMODEW = unsafe { std::mem::zeroed() };
    mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
    // Display settings are physical pixels, independent of the WebView's DPI.
    if unsafe { EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut mode) } == 0 {
        return Err("REMOTE_MEDIA_LAYOUT_UNAVAILABLE");
    }
    let display = unsafe { mode.Anonymous1.Anonymous2 };
    DisplaySnapshot {
        display_id: 1,
        bounds: Rect {
            x: f64::from(display.dmPosition.x),
            y: f64::from(display.dmPosition.y),
            width: f64::from(mode.dmPelsWidth),
            height: f64::from(mode.dmPelsHeight),
        },
        pixels: PixelSize { width: mode.dmPelsWidth, height: mode.dmPelsHeight },
        rotation_degrees: match display.dmDisplayOrientation {
            0 => 0, 1 => 90, 2 => 180, 3 => 270,
            _ => return Err("REMOTE_MEDIA_LAYOUT_INVALID"),
        },
    }.validate()
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn primary_display_snapshot() -> LayoutResult<DisplaySnapshot> {
    Err("REMOTE_MEDIA_LAYOUT_UNSUPPORTED")
}

#[cfg(test)]
pub(super) fn fixture() -> MediaLayout {
    MediaLayout::parse(serde_json::json!({"screenId":"primary","layoutVersion":1,"geometry":{"displayId":1,"coordinateSpace":"quartz-global-logical","displayBounds":{"x":0,"y":0,"width":1920,"height":1080},"displayPixels":{"width":3840,"height":2160},"rotationDegrees":0,"encodedSize":{"width":1280,"height":720},"contentRect":{"x":0,"y":0,"width":1280,"height":720}}})).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn windows_coordinate_space_is_preserved_and_unknown_spaces_are_rejected() {
        let mut layout = fixture();
        layout.geometry.coordinate_space = "windows-desktop-physical".into();
        assert!(layout.validate().is_ok());
        assert_eq!(MediaLayout::parse(serde_json::to_value(&layout).unwrap()).unwrap(), layout);
        layout.geometry.coordinate_space = "unverified".into();
        assert!(layout.validate().is_err());
    }
    #[test]
    fn shared_fixture_maps_retina_centres_edges_and_rotations_without_double_transform() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/remote-control-layout-v1.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let layout = MediaLayout::parse(case["layout"].clone()).unwrap();
            for rotation in [0, 90, 180, 270] {
                let mut snapshot = layout.geometry.display_snapshot();
                snapshot.rotation_degrees = rotation;
                snapshot.validate().unwrap();
                for sample in case["nativeCases"].as_array().unwrap() {
                    let expected = (
                        sample["point"]["x"].as_f64().unwrap(),
                        sample["point"]["y"].as_f64().unwrap(),
                    );
                    assert_eq!(
                        snapshot.point(
                            sample["normalized"]["x"].as_f64().unwrap(),
                            sample["normalized"]["y"].as_f64().unwrap()
                        ),
                        Some(expected)
                    );
                }
                assert_eq!(snapshot.point(-0.001, 0.5), None);
                assert_eq!(snapshot.point(0.5, 1.001), None);
                assert_eq!(snapshot.point(f64::NAN, 0.5), None);
            }
        }
    }
    #[test]
    fn physical_pixels_follow_current_bounds_via_direct_or_swapped_mode_dimensions() {
        let mut bounds = Rect {
            x: -900.0,
            y: 120.0,
            width: 1440.0,
            height: 900.0,
        };
        let mode = PixelSize {
            width: 1440,
            height: 900,
        };
        let pixels = PixelSize {
            width: 2880,
            height: 1800,
        };
        assert_eq!(oriented_mode_pixels(bounds, mode, pixels).unwrap(), pixels);
        bounds.width = 900.0;
        bounds.height = 1440.0;
        let portrait = PixelSize {
            width: 1800,
            height: 2880,
        };
        assert_eq!(
            oriented_mode_pixels(bounds, mode, pixels).unwrap(),
            portrait
        );
        assert_eq!(
            oriented_mode_pixels(
                bounds,
                PixelSize {
                    width: 900,
                    height: 1440
                },
                portrait
            )
            .unwrap(),
            portrait
        );
        bounds.height = 1400.0;
        assert!(oriented_mode_pixels(bounds, mode, pixels).is_err());
    }
    #[test]
    fn layout_rejects_unknown_fields_invalid_units_sizes_and_out_of_frame_content() {
        let original = serde_json::to_value(fixture()).unwrap();
        for path in [
            "/extra",
            "/geometry/extra",
            "/geometry/displayBounds/extra",
            "/geometry/contentRect/extra",
            "/geometry/displayPixels/extra",
        ] {
            let (object, key) = path.rsplit_once('/').unwrap();
            let mut value = original.clone();
            value
                .pointer_mut(object)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(key.into(), json!(1));
            assert!(MediaLayout::parse(value).is_err(), "{path}");
        }
        for (path, value) in [
            ("/screenId", json!("other")),
            ("/layoutVersion", json!(0)),
            ("/layoutVersion", json!(1.5)),
            ("/geometry/displayId", json!(0)),
            ("/geometry/coordinateSpace", json!("pixels")),
            ("/geometry/displayBounds/x", json!(1_000_001)),
            ("/geometry/displayBounds/width", json!(-1)),
            ("/geometry/displayPixels/width", json!(0)),
            ("/geometry/displayPixels/height", json!(16385)),
            ("/geometry/rotationDegrees", json!(45)),
            ("/geometry/encodedSize/width", json!(1.5)),
            ("/geometry/contentRect/x", json!(-0.5)),
            ("/geometry/contentRect/y", json!(720)),
            ("/geometry/contentRect/width", json!(1281)),
            ("/geometry/contentRect/height", json!(0)),
        ] {
            let mut invalid = original.clone();
            *invalid.pointer_mut(path).unwrap() = value;
            assert!(MediaLayout::parse(invalid).is_err(), "{path}");
        }
        let mut fractional = original;
        fractional["geometry"]["contentRect"] =
            json!({"x":0.25,"y":0.25,"width":1279.5,"height":719.5});
        assert!(MediaLayout::parse(fractional).is_ok());
    }
    #[test]
    fn every_geometry_change_invalidates_the_tracker_permanently() {
        let original = serde_json::to_value(fixture()).unwrap();
        for (path, next) in [
            ("/layoutVersion", json!(2)),
            ("/geometry/displayId", json!(2)),
            ("/geometry/displayBounds/x", json!(100)),
            ("/geometry/displayBounds/height", json!(900)),
            ("/geometry/displayPixels/width", json!(1920)),
            ("/geometry/rotationDegrees", json!(90)),
            ("/geometry/encodedSize/width", json!(1300)),
            ("/geometry/contentRect/width", json!(1200)),
        ] {
            let mut tracker = LayoutTracker::default();
            assert!(tracker.snapshot().unwrap().is_none());
            tracker.observe(original.clone()).unwrap();
            tracker.observe(original.clone()).unwrap();
            let mut changed = original.clone();
            *changed.pointer_mut(path).unwrap() = next;
            assert!(tracker.observe(changed).is_err(), "{path}");
            assert!(tracker.snapshot().is_err());
            assert!(tracker.observe(original.clone()).is_err());
        }
    }
}
