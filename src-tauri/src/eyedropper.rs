// Screen colour sampling for the app's own eyedropper.
//
// The droplet inside Chromium's native `<input type="color">` picker is drawn by
// Blink but implemented by the embedder (`WebContentsViewDelegate::CreateEyeDropper`).
// WebView2 supplies no eyedropper, so that button — and `window.EyeDropper` with it —
// does nothing in the Tauri shell. ui/js/eyedropper.js drives its own picker instead
// and polls this command for the pixels around the OS cursor while the user drags.

use serde::Serialize;

/// Largest half-width we will grab, in screen pixels. Every poll ships
/// `(2 * radius + 1)^2` numbers across the IPC bridge, so keep the loupe modest.
const MAX_RADIUS: u32 = 24;

/// A square of desktop pixels centred on the mouse cursor.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPick {
    /// Cursor position, in physical screen pixels.
    pub x: i32,
    pub y: i32,
    /// Side length of `pixels`, always `2 * radius + 1`.
    pub size: u32,
    /// The colour directly under the cursor, as `#rrggbb`.
    pub hex: String,
    /// Row-major, top-down, one `0x00rrggbb` per pixel. Pixels that fall outside the
    /// desktop (cursor near an edge) come back black.
    pub pixels: Vec<u32>,
    /// Physical mouse and Escape state. The picker commits on a click, and the click
    /// that ends it often lands on another application's window, where no DOM event
    /// of ours will ever fire — so it watches these instead.
    pub left: bool,
    pub right: bool,
    pub escape: bool,
}

#[tauri::command]
pub fn screen_pick(radius: u32) -> Result<ScreenPick, String> {
    imp::grab(radius.min(MAX_RADIUS))
}

#[cfg(windows)]
mod imp {
    use super::ScreenPick;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP,
        HDC, HGDIOBJ, SRCCOPY,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    /// High bit set = the key is down right now. The low bit ("pressed since the last
    /// call") is deliberately ignored: reading it clears it, which would race the
    /// picker's own polling.
    unsafe fn is_down(vk: u16) -> bool {
        (GetAsyncKeyState(vk as i32) as u16) & 0x8000 != 0
    }

    /// Frees the handles on every exit path, including the early `?` returns.
    struct Gdi {
        screen: HDC,
        mem: HDC,
        bmp: HBITMAP,
        prev: HGDIOBJ,
    }

    impl Drop for Gdi {
        fn drop(&mut self) {
            unsafe {
                if !self.mem.is_null() {
                    if !self.prev.is_null() {
                        SelectObject(self.mem, self.prev);
                    }
                    DeleteDC(self.mem);
                }
                if !self.bmp.is_null() {
                    DeleteObject(self.bmp);
                }
                ReleaseDC(std::ptr::null_mut(), self.screen);
            }
        }
    }

    pub fn grab(radius: u32) -> Result<ScreenPick, String> {
        let r = radius as i32;
        let size = r * 2 + 1;

        unsafe {
            let mut cursor = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut cursor) == 0 {
                return Err("GetCursorPos failed".into());
            }

            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err("no device context for the screen".into());
            }
            let mut gdi = Gdi {
                screen,
                mem: std::ptr::null_mut(),
                bmp: std::ptr::null_mut(),
                prev: std::ptr::null_mut(),
            };

            gdi.mem = CreateCompatibleDC(screen);
            if gdi.mem.is_null() {
                return Err("could not create a memory device context".into());
            }

            // Negative height = top-down rows, so `pixels` needs no flip. A 32bpp
            // BI_RGB pixel is laid out B,G,R,unused, which reads back little-endian
            // as exactly 0x00rrggbb.
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = size;
            info.bmiHeader.biHeight = -size;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB;

            let mut bits: *mut c_void = std::ptr::null_mut();
            gdi.bmp = CreateDIBSection(
                gdi.mem,
                &info,
                DIB_RGB_COLORS,
                &mut bits,
                std::ptr::null_mut(),
                0,
            );
            if gdi.bmp.is_null() || bits.is_null() {
                return Err("could not allocate the capture bitmap".into());
            }
            gdi.prev = SelectObject(gdi.mem, gdi.bmp);

            // CAPTUREBLT pulls in layered windows — tooltips, menus, the app's own
            // popups — that a plain SRCCOPY would blit straight through.
            let ok = BitBlt(
                gdi.mem,
                0,
                0,
                size,
                size,
                screen,
                cursor.x - r,
                cursor.y - r,
                SRCCOPY | CAPTUREBLT,
            );
            if ok == 0 {
                return Err("screen capture failed".into());
            }

            let count = (size * size) as usize;
            let pixels: Vec<u32> = std::slice::from_raw_parts(bits as *const u32, count)
                .iter()
                .map(|p| p & 0x00ff_ffff)
                .collect();
            let centre = pixels[count / 2];

            Ok(ScreenPick {
                x: cursor.x,
                y: cursor.y,
                size: size as u32,
                hex: format!("#{:06x}", centre),
                pixels,
                left: is_down(VK_LBUTTON),
                right: is_down(VK_RBUTTON),
                escape: is_down(VK_ESCAPE),
            })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::ScreenPick;

    pub fn grab(_radius: u32) -> Result<ScreenPick, String> {
        Err("screen colour picking is only implemented on Windows".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    // Any Windows desktop session can be grabbed, so these check the shape of what
    // comes back rather than the colours, which depend on what is on screen.
    #[test]
    fn grabs_a_square_around_the_cursor() {
        let shot = screen_pick(2).expect("screen grab");
        assert_eq!(shot.size, 5);
        assert_eq!(shot.pixels.len(), 25);
        assert!(
            shot.pixels.iter().all(|p| *p <= 0x00ff_ffff),
            "the unused fourth byte of each DIB pixel must be masked off"
        );
        assert_eq!(shot.hex, format!("#{:06x}", shot.pixels[12]));
    }

    #[test]
    fn radius_is_clamped() {
        let shot = screen_pick(9999).expect("screen grab");
        assert_eq!(shot.size, MAX_RADIUS * 2 + 1);
        assert_eq!(shot.pixels.len(), (shot.size * shot.size) as usize);
    }
}
