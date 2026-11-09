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

    // Normalize nested directory output so docs root (index.html, src/, assets/) is at output_dir root.
    normalize_extracted_root(output_dir);

    // Create case-insensitive aliases for all files to support APFS.
    create_case_insensitive_aliases(output_dir);

    if !output_dir.join("index.html").is_file() {
        return Err(-5);
    }

    let exported = i32::try_from(summary.exported).unwrap_or(i32::MAX);
    Ok(exported.max(1))
}

fn create_case_insensitive_aliases(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            create_case_insensitive_aliases(&path);
        } else if path.is_file() {
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                let lower = file_name.to_lowercase();
                if lower != file_name {
                    let alias = path.with_file_name(&lower);
                    if !alias.exists() {
                        let _ = fs::copy(&path, &alias);
                    }
                }
            }
        }
    }
}

fn normalize_extracted_root(output_dir: &Path) {
    let Some(docs_root) = find_best_docs_root(output_dir) else {
        return;
    };
    if docs_root == output_dir {
        return;
    }
    move_children_merge(&docs_root, output_dir);
}

fn move_children_merge(from_dir: &Path, to_dir: &Path) {
    let Ok(entries) = fs::read_dir(from_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = to_dir.join(entry.file_name());
        if from.is_dir() {
            if to.is_dir() {
                move_children_merge(&from, &to);
                let _ = fs::remove_dir(&from);
            } else if !to.exists() {
                let _ = fs::rename(&from, &to);
            }
        } else if !to.exists() {
            let _ = fs::rename(&from, &to);
        }
    }
}

fn find_best_docs_root(root: &Path) -> Option<PathBuf> {
    fn is_complete_docs(dir: &Path) -> bool {
        dir.join("index.html").is_file()
            && dir.join("src").join("settings.json").is_file()
            && dir.join("src").join("import-map.json").is_file()
            && dir.join("assets").is_dir()
            && dir.join("cocos-js").is_dir()
    }

    if is_complete_docs(root) {
        return Some(root.to_path_buf());
    }

    let mut queue = vec![(root.to_path_buf(), 0)];
    let mut candidates = Vec::new();

    while let Some((dir, depth)) = queue.pop() {
        if depth > 4 {
            continue;
        }
        if is_complete_docs(&dir) {
            candidates.push(dir);
            continue;
        }
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    queue.push((p, depth + 1));
                }
            }
        }
    }

    candidates.sort_by(|a, b| {
        let a_is_docs = a.file_name().and_then(|n| n.to_str()) == Some("docs");
        let b_is_docs = b.file_name().and_then(|n| n.to_str()) == Some("docs");
        if a_is_docs != b_is_docs {
            b_is_docs.cmp(&a_is_docs)
        } else {
            a.components().count().cmp(&b.components().count())
        }
    });

    candidates.into_iter().next()
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
