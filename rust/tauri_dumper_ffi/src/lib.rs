use std::ffi::{CStr, c_char, c_int};
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use tauri_dumper::{AssetScanner, BinaryImage, ExportOptions};

/// Error codes returned across the C/JNI FFI boundary:
/// - `> 0`: Number of embedded frontend files successfully extracted
/// - `-1`: Invalid pointer or UTF-8 path argument
/// - `-2`: Failed to open or memory-map the input `.exe` file
/// - `-3`: Input `.exe` is not a valid Tauri binary or has no embedded asset table
/// - `-4`: Failed to decompress or write Brotli-compressed assets to disk
/// - `-5`: Extracted assets did not contain `index.html`
/// - `-99`: Unexpected internal panic caught at FFI boundary
fn extract_tauri_exe_impl(exe_path: &Path, output_dir: &Path) -> Result<i32, i32> {
    if !exe_path.is_file() {
        return Err(-2);
    }
    fs::create_dir_all(output_dir).map_err(|_| -4)?;

    // Memory-map the PE binary (zero full-file heap allocation on mobile).
    let image = BinaryImage::open(exe_path).map_err(|_| -2)?;

    // Scan PE `.rdata` sections for the embedded Tauri asset index table.
    let table = AssetScanner::scan(&image).map_err(|_| -3)?;

    // Decompress Brotli chunks incrementally into `output_dir`.
    let options = ExportOptions::new(output_dir);
    let summary = table.export(&options).map_err(|_| -4)?;

    // Clean up tauri-dumper's diagnostic manifest so only game web assets remain.
    let _ = fs::remove_file(output_dir.join("tauri-dumper.manifest.json"));

    // Normalize nested single-directory output if `index.html` was embedded under a prefix.
    normalize_extracted_root(output_dir);

    if !output_dir.join("index.html").is_file() {
        return Err(-5);
    }

    let exported = i32::try_from(summary.exported).unwrap_or(i32::MAX);
    Ok(exported.max(1))
}

fn normalize_extracted_root(output_dir: &Path) {
    if output_dir.join("index.html").is_file() {
        return;
    }
    let Some(nested_root) = find_nested_index_root(output_dir, 2) else {
        return;
    };
    if nested_root == output_dir {
        return;
    }
    let Ok(entries) = fs::read_dir(&nested_root) else {
        return;
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = output_dir.join(entry.file_name());
        if !to.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
}

fn find_nested_index_root(dir: &Path, max_depth: usize) -> Option<PathBuf> {
    if dir.join("index.html").is_file() {
        return Some(dir.to_path_buf());
    }
    if max_depth == 0 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_nested_index_root(&path, max_depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

/// C-ABI entry point for iOS (`AppDelegate.swift` via `Runner-Bridging-Header.h`)
/// and Dart FFI (`DynamicLibrary.process()`).
#[no_mangle]
pub unsafe extern "C" fn gardendless_extract_tauri_exe(
    exe_path: *const c_char,
    output_dir: *const c_char,
) -> c_int {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if exe_path.is_null() || output_dir.is_null() {
            return -1;
        }
        let Ok(exe_str) = unsafe { CStr::from_ptr(exe_path) }.to_str() else {
            return -1;
        };
        let Ok(out_str) = unsafe { CStr::from_ptr(output_dir) }.to_str() else {
            return -1;
        };
        match extract_tauri_exe_impl(Path::new(exe_str), Path::new(out_str)) {
            Ok(count) => count,
            Err(code) => code,
        }
    }));
    result.unwrap_or(-99)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_io_github_dey410_gardendlessloader_MainActivity_nativeExtractTauriExe<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    exe_path: jni::objects::JString<'local>,
    output_dir: jni::objects::JString<'local>,
) -> jni::sys::jint {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let exe_str: String = match env.get_string(&exe_path) {
            Ok(s) => s.into(),
            Err(_) => return -1,
        };
        let out_str: String = match env.get_string(&output_dir) {
            Ok(s) => s.into(),
            Err(_) => return -1,
        };
        match extract_tauri_exe_impl(Path::new(&exe_str), Path::new(&out_str)) {
            Ok(count) => count,
            Err(code) => code,
        }
    }));
    result.unwrap_or(-99)
}
