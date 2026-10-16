//! Locate the white interior of a closed speech balloon around an OCR context group.
use anyhow::{bail, Result};
use image::DynamicImage;

pub fn bubble_crop(image: &DynamicImage, bounds: [f64; 4], font: f64) -> Result<(u32, u32, u32, u32)> {
    let [left, top, right, bottom] = bounds;
    if bounds.iter().any(|v| !v.is_finite()) || right <= left || bottom <= top ||
        right <= 0.0 || bottom <= 0.0 || left >= image.width() as f64 || top >= image.height() as f64 {
        bail!("文字框不在原图内");
    }
    let font = if font.is_finite() { font.clamp(8.0, 200.0) } else { 16.0 };
    let width = right - left;
    let height = bottom - top;
    let clamp = |x1: f64, y1: f64, x2: f64, y2: f64| {
        let x1 = x1.floor().clamp(0.0, image.width() as f64) as u32;
        let y1 = y1.floor().clamp(0.0, image.height() as f64) as u32;
        let x2 = x2.ceil().clamp(0.0, image.width() as f64) as u32;
        let y2 = y2.ceil().clamp(0.0, image.height() as f64) as u32;
        (x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1))
    };
    let search_x = (width * 0.75).max(font * 5.0);
    let search_y = (height * 0.5).max(font * 5.0);
    let (sx, sy, sw, sh) = clamp(left - search_x, top - search_y, right + search_x, bottom + search_y);
    let gray = image.crop_imm(sx, sy, sw, sh).to_luma8();
    let pixels = gray.as_raw();
    let mut visited = vec![false; pixels.len()];
    let mut best: Option<(u32, u32, u32, u32, usize)> = None;
    // Samples on and around the text find whitespace between glyphs and columns.
    for iy in 0..7 {
        for ix in 0..7 {
            let x = (left - font * 0.4 + (width + font * 0.8) * ix as f64 / 6.0 - sx as f64)
                .round().clamp(0.0, sw.saturating_sub(1) as f64) as usize;
            let y = (top - font * 0.4 + (height + font * 0.8) * iy as f64 / 6.0 - sy as f64)
                .round().clamp(0.0, sh.saturating_sub(1) as f64) as usize;
            let seed = y * sw as usize + x;
            if visited[seed] || pixels[seed] < 225 { continue; }
            let mut queue = vec![seed];
            visited[seed] = true;
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (x, y, x, y);
            let mut edge = false;
            let mut cursor = 0;
            while cursor < queue.len() {
                let current = queue[cursor]; cursor += 1;
                let cx = current % sw as usize;
                let cy = current / sw as usize;
                min_x = min_x.min(cx); min_y = min_y.min(cy);
                max_x = max_x.max(cx); max_y = max_y.max(cy);
                if cx == 0 || cy == 0 || cx + 1 == sw as usize || cy + 1 == sh as usize { edge = true; }
                let neighbors = [
                    if cx > 0 { Some(current - 1) } else { None },
                    if cx + 1 < sw as usize { Some(current + 1) } else { None },
                    if cy > 0 { Some(current - sw as usize) } else { None },
                    if cy + 1 < sh as usize { Some(current + sw as usize) } else { None },
                ];
                for next in neighbors.into_iter().flatten() {
                    if !visited[next] && pixels[next] >= 225 { visited[next] = true; queue.push(next); }
                }
            }
            let x1 = sx + min_x as u32; let y1 = sy + min_y as u32;
            let x2 = sx + max_x as u32 + 1; let y2 = sy + max_y as u32 + 1;
            let contains = x1 as f64 <= left + font * 0.25 && y1 as f64 <= top + font * 0.25 &&
                x2 as f64 >= right - font * 0.25 && y2 as f64 >= bottom - font * 0.25;
            // Open backgrounds/panels touching the search edge are not speech balloons.
            if !edge && contains && queue.len() >= (width * height * 0.15) as usize &&
                best.as_ref().is_none_or(|old| queue.len() < old.4) {
                best = Some((x1, y1, x2, y2, queue.len()));
            }
        }
    }
    if let Some((x1, y1, x2, y2, _)) = best {
        let border = (font * 0.4).clamp(6.0, 24.0);
        Ok(clamp(x1 as f64 - border, y1 as f64 - border, x2 as f64 + border, y2 as f64 + border))
    } else {
        let pad_x = (width * 0.18).max(font * 1.3).max(12.0);
        let pad_y = (height * 0.14).max(font * 1.3).max(12.0);
        Ok(clamp(left - pad_x, top - pad_y, right + pad_x, bottom + pad_y))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    #[test]
    fn captures_closed_balloon_border_and_tail_instead_of_single_text_column() {
        let mut image = RgbImage::from_pixel(500, 500, Rgb([170, 170, 170]));
        for y in 70..330 { for x in 80..320 {
            let border = x < 84 || x >= 316 || y < 74 || y >= 326;
            image.put_pixel(x, y, if border { Rgb([0, 0, 0]) } else { Rgb([255, 255, 255]) });
        }}
        // A tail joins the interior through the lower border.
        for y in 320..365 {
            let right = 225_u32.saturating_sub((y - 320) / 2);
            for x in 190..=right {
                image.put_pixel(x, y, if x == 190 || x == right || y == 364 { Rgb([0,0,0]) } else { Rgb([255,255,255]) });
            }
        }
        for y in 115..260 { for x in [130, 190, 245] { image.put_pixel(x, y, Rgb([0, 0, 0])); }}
        let (x, y, width, height) = bubble_crop(&DynamicImage::ImageRgb8(image), [125., 110., 250., 265.], 20.).unwrap();
        assert!(x <= 80 && y <= 70 && x + width >= 320 && y + height >= 365);
        assert!(width < 300 && height < 340);
    }
    #[test]
    fn open_background_falls_back_to_bounded_context_and_rejects_invalid_geometry() {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(200, 200, Rgb([255, 255, 255])));
        let (x, y, w, h) = bubble_crop(&image, [10., 20., 100., 130.], 20.).unwrap();
        assert_eq!(x, 0); assert_eq!(y, 0); assert!(w > 100 && w < 200 && h > 130 && h < 200);
        assert!(bubble_crop(&image, [f64::NAN, 0., 10., 10.], 20.).is_err());
        assert!(bubble_crop(&image, [250., 0., 300., 10.], 20.).is_err());
    }
}
