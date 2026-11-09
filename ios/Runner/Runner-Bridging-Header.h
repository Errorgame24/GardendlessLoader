#import "GeneratedPluginRegistrant.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Extracts embedded Brotli-compressed frontend assets from a Tauri PE `.exe`
/// into `output_dir`. Returns the number of exported files (`> 0`) on success,
/// or a negative error code (`< 0`) on failure.
int32_t gardendless_extract_tauri_exe(const char *exe_path, const char *output_dir);

#ifdef __cplusplus
}
#endif
