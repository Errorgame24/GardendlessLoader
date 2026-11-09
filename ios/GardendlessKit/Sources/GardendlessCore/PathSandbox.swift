import Foundation

/// Confines every resource path to one directory while rejecting traversal,
/// symbolic links, double encoding, and unsafe components.
public struct PathSandbox {
  public let root: URL

  public init(root: URL) throws {
    let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
      throw GameError.failed(.invalidPath, "Resource root is not a safe directory")
    }
    self.root = root.resolvingSymlinksInPath().standardizedFileURL
  }

  public func relativePath(for url: URL) -> String? {
    guard url.scheme == GameOrigin.scheme, url.host == GameOrigin.host,
          let encoded = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
          )?.percentEncodedPath,
          let decoded = encoded.removingPercentEncoding else {
      return nil
    }
    if decoded.range(
      of: "%(?:2e|2f|5c|25)",
      options: [.regularExpression, .caseInsensitive]
    ) != nil {
      return nil
    }
    let path = decoded.hasPrefix("/") ? String(decoded.dropFirst()) : decoded
    let effective = path.isEmpty ? "index.html" : path
    let components = effective.split(
      separator: "/",
      omittingEmptySubsequences: false
    ).map(String.init)
    guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
          !Self.isPackageMetadataPath(effective),
          !effective.contains("\\"),
          !effective.contains("\0") else {
      return nil
    }
    return components.joined(separator: "/")
  }

  public func resolve(_ relativePath: String) -> URL? {
    guard !relativePath.isEmpty, !relativePath.hasPrefix("/"),
          !Self.isPackageMetadataPath(relativePath) else { return nil }

    // First attempt: direct resolution under root
    if let direct = resolveUnder(root: root, relativePath: relativePath) {
      return direct
    }

    if relativePath.hasPrefix("gp-next/") {
      if relativePath == "gp-next/settings.json" {
        return resolveUnder(root: root, relativePath: "src/settings.json")
      }
      if relativePath == "gp-next/import-map.json" {
        return resolveUnder(root: root, relativePath: "src/import-map.json")
      }
      let stripped = String(relativePath.dropFirst(8))
      if let found = resolveUnder(root: root, relativePath: stripped)
        ?? resolveUnder(root: root, relativePath: "assets/\(stripped)") {
        return found
      }
      return nil
    }

    // Fallbacks for game assets
    let base = (relativePath as NSString).lastPathComponent
    var fallbacks = [
      "assets/\(relativePath)",
      "data/\(relativePath)",
      "assets/data/\(relativePath)",
      "data/\(base)",
      "assets/data/\(base)",
      relativePath == "settings.json" ? "src/settings.json" : nil,
      relativePath == "import-map.json" ? "src/import-map.json" : nil,
    ].compactMap { $0 }

    if !relativePath.hasSuffix(".json") {
      fallbacks.append("\(relativePath).json")
      fallbacks.append("data/\(relativePath).json")
      fallbacks.append("assets/data/\(relativePath).json")
      fallbacks.append("assets/\(relativePath).json")
      fallbacks.append("data/\(base).json")
      fallbacks.append("assets/data/\(base).json")
    }

    for candidate in fallbacks {
      if let found = resolveUnder(root: root, relativePath: candidate) {
        return found
      }
    }

    return nil
  }

  private func resolveUnder(root: URL, relativePath: String) -> URL? {
    var cursor = root
    for component in relativePath.split(
      separator: "/",
      omittingEmptySubsequences: false
    ) {
      guard !component.isEmpty, component != ".", component != ".." else {
        return nil
      }
      let direct = cursor.appendingPathComponent(String(component), isDirectory: false)
      if FileManager.default.fileExists(atPath: direct.path) {
        cursor = direct
      } else {
        var matched = false
        if let contents = try? FileManager.default.contentsOfDirectory(atPath: cursor.path) {
          let lower = component.lowercased()
          if let found = contents.first(where: { $0.lowercased() == lower }) {
            cursor.appendPathComponent(found, isDirectory: false)
            matched = true
          }
        }
        if !matched {
          cursor = direct
        }
      }
      if (try? cursor.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink)
        == true {
        return nil
      }
    }
    let resolved = cursor.resolvingSymlinksInPath().standardizedFileURL
    let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
    guard resolved.path.hasPrefix(rootPath),
          (try? resolved.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile)
            == true else {
      return nil
    }
    return resolved
  }

  private static func isPackageMetadataPath(_ path: String) -> Bool {
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    return components.count >= 2 && components[0].lowercased() == "__gardendless"
      && components[1].lowercased() == "package"
  }

  public func fileProperties(_ file: URL) throws -> (length: Int64, etag: String) {
    let values = try file.resourceValues(
      forKeys: [.fileSizeKey, .contentModificationDateKey]
    )
    let length = Int64(values.fileSize ?? 0)
    let modified = Int(values.contentModificationDate?.timeIntervalSince1970 ?? 0)
    return (length, "\"\(modified)-\(length)\"")
  }
}
