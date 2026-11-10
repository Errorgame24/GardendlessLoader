import Flutter
import Foundation
import GardendlessCore
import GardendlessImport
import GardendlessLogging
import UniformTypeIdentifiers
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  private let logStore: LogStore = {
    let support = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    )[0]
    return LogStore(
      directory: support.appendingPathComponent(
        "GardendlessLoader/logs",
        isDirectory: true
      )
    )
  }()

  private var launcherEngine: FlutterEngine?
  private var gameHostChannel: FlutterMethodChannel?
  private var resourceZipImporterChannel: FlutterMethodChannel?
  private var displayChannel: FlutterMethodChannel?
  private var orientationObserver: NSObjectProtocol?
  private var reportedSensorHousingEdge: String?
  private var lastImportProgressReportAt: UInt64 = 0
  private var pendingImportResult: FlutterResult?
  private var pendingImportTargetDirectory: String?
  private var zipImportInProgress = false
  private var gameLaunchInProgress = false
  /// A ZIP or EXE another app opened or shared with the loader. It waits here while
  /// the game runs and until the launcher imports or discards it.
  private var incomingZip: IncomingZip?
  private var shortcutChannel: FlutterMethodChannel?
  /// The home-screen shortcut that started the app, until the launcher takes it.
  var pendingShortcut: String?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let launched = super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions
    )
    logStore.initialize()
    return launched
  }

  override func applicationWillTerminate(_ application: UIApplication) {
    logStore.endSession()
    super.applicationWillTerminate(application)
  }

  func showLauncher() {
    let engine = FlutterEngine(name: "gardendless-launcher-\(UUID().uuidString)")
    guard engine.run() else { return }
    GeneratedPluginRegistrant.register(with: engine)
    let controller = FlutterViewController(engine: engine, nibName: nil, bundle: nil)
    launcherEngine = engine
    window?.rootViewController = controller
    window?.makeKeyAndVisible()
    registerChannels(on: controller.binaryMessenger)
  }

  private func registerChannels(on messenger: FlutterBinaryMessenger) {
    registerExternalBrowser(on: messenger)
    registerGameHost(on: messenger)
    registerResourceZipImporter(on: messenger)
    registerAppLogger(on: messenger)
    registerDisplay(on: messenger)
    registerShortcuts(on: messenger)
  }

  private func registerShortcuts(on messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(
      name: "io.github.dey410.gardendlessloader/shortcuts",
      binaryMessenger: messenger
    )
    shortcutChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      switch call.method {
      case "take":
        result(self?.pendingShortcut)
        self?.pendingShortcut = nil
      case "setItems":
        guard let titles = call.arguments as? [String: String] else {
          result(
            FlutterError(
              code: "invalid_shortcuts",
              message: "Shortcut titles must be a string map",
              details: nil
            )
          )
          return
        }
        let symbols = ["startGame": "play.fill", "importResources": "square.and.arrow.down"]
        UIApplication.shared.shortcutItems = ["startGame", "importResources"].compactMap { type in
          titles[type].map { title in
            UIApplicationShortcutItem(
              type: type,
              localizedTitle: title,
              localizedSubtitle: nil,
              icon: symbols[type].map { UIApplicationShortcutIcon(systemImageName: $0) },
              userInfo: nil
            )
          }
        }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  /// A shortcut used while the app runs. During play it only brings the game
  /// back, so it never restarts the game or swaps resources under it.
  func performShortcut(_ type: String) {
    guard launcherEngine != nil else { return }
    shortcutChannel?.invokeMethod("perform", arguments: type)
  }

  // iOS reports equal left and right safe-area insets in landscape, so
  // Flutter cannot tell which long edge holds the notch or Dynamic Island.
  // Report it from the interface orientation and push changes, including
  // 180° flips that leave the screen size and insets unchanged.
  private func registerDisplay(on messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(
      name: "io.github.dey410.gardendlessloader/display",
      binaryMessenger: messenger
    )
    displayChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "sensorHousingEdge" else {
        result(FlutterMethodNotImplemented)
        return
      }
      let edge = self?.currentSensorHousingEdge()
      self?.reportedSensorHousingEdge = edge
      result(edge)
    }
    UIDevice.current.beginGeneratingDeviceOrientationNotifications()
    orientationObserver = NotificationCenter.default.addObserver(
      forName: UIDevice.orientationDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      // The interface finishes rotating after the device notification.
      for delay in [0.05, 0.6] {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
          self?.reportSensorHousingEdgeIfChanged()
        }
      }
    }
  }

  private func reportSensorHousingEdgeIfChanged() {
    let edge = currentSensorHousingEdge()
    guard edge != reportedSensorHousingEdge else { return }
    reportedSensorHousingEdge = edge
    displayChannel?.invokeMethod("sensorHousingEdgeChanged", arguments: edge)
  }

  /// "left" or "right" for the edge holding the sensor housing in
  /// landscape, nil otherwise. Interface `.landscapeRight` puts the home
  /// side on the right, so the top of the device faces left.
  private func currentSensorHousingEdge() -> String? {
    let scene = window?.windowScene
      ?? UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first
    switch scene?.interfaceOrientation {
    case .landscapeRight:
      return "left"
    case .landscapeLeft:
      return "right"
    default:
      return nil
    }
  }

  private func registerExternalBrowser(on messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(
      name: "io.github.dey410.gardendlessloader/external_browser",
      binaryMessenger: messenger
    )
    channel.setMethodCallHandler { call, result in
      guard call.method == "open" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard let arguments = call.arguments as? [String: Any],
            let raw = arguments["url"] as? String,
            let url = URL(string: raw),
            url.scheme == "https" || url.scheme == "http" else {
        result(
          FlutterError(
            code: "invalid_external_url",
            message: "Only HTTP(S) URLs are allowed",
            details: nil
          )
        )
        return
      }
      UIApplication.shared.open(url) { opened in
        if opened {
          result(nil)
        } else {
          result(
            FlutterError(
              code: "external_open_failed",
              message: "No application can open this URL",
              details: nil
            )
          )
        }
      }
    }
  }

  private func registerGameHost(on messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(
      name: "io.github.dey410.gardendlessloader/game_host",
      binaryMessenger: messenger
    )
    gameHostChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "launch" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard let self else {
        result(
          FlutterError(
            code: "game_host_unavailable",
            message: "App delegate released",
            details: nil
          )
        )
        return
      }
      guard !self.gameLaunchInProgress else {
        result(
          FlutterError(
            code: "game_host_launch_busy",
            message: "Native GameHost is launching",
            details: nil
          )
        )
        return
      }
      do {
        let session = try GameSessionDecoder.decode(call.arguments)
        self.gameLaunchInProgress = true
        NetworkPolicy.load(for: session) { [weak self] policyResult in
          DispatchQueue.main.async {
            guard let self else {
              result(
                FlutterError(
                  code: "game_host_unavailable",
                  message: "App delegate released",
                  details: nil
                )
              )
              return
            }
            self.gameLaunchInProgress = false
            do {
              let policy = try policyResult.get()
              let gameController = try GameHostController(
                session: session,
                networkRuleList: policy,
                logStore: self.logStore
              ) { [weak self] in
                self?.showLauncher()
              }
              let engine = self.launcherEngine
              self.launcherEngine = nil
              self.resourceZipImporterChannel?.setMethodCallHandler(nil)
              self.gameHostChannel?.setMethodCallHandler(nil)
              result(nil)
              self.window?.rootViewController = gameController
              self.window?.makeKeyAndVisible()
              DispatchQueue.main.async {
                engine?.destroyContext()
              }
            } catch {
              result(
                FlutterError(
                  code: "game_host_launch_failed",
                  message: error.localizedDescription,
                  details: nil
                )
              )
            }
          }
        }
      } catch {
        result(
          FlutterError(
            code: "game_host_launch_failed",
            message: error.localizedDescription,
            details: nil
          )
        )
      }
    }
  }

  private func registerResourceZipImporter(on messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(
      name: "io.github.dey410.gardendlessloader/resource_zip_importer",
      binaryMessenger: messenger
    )
    resourceZipImporterChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(nil)
        return
      }
      switch call.method {
      case "pickAndExtractDocsZip":
        self.pickAndExtractDocsZip(call: call, result: result)
      case "incomingZip":
        result(self.incomingZip?.url.lastPathComponent)
      case "discardIncomingZip":
        self.incomingZip?.discard()
        self.incomingZip = nil
        result(nil)
      case "extractIncomingDocsZip":
        self.extractIncomingDocsZip(call: call, result: result)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  /// Keeps the latest ZIP/EXE opened or shared with the loader; a running
  /// launcher is told at once, otherwise it asks when it starts.
  func receiveIncomingZip(_ context: UIOpenURLContext) {
    incomingZip?.discard()
    let zip = IncomingZip(url: context.url, isCopy: !context.options.openInPlace)
    incomingZip = zip
    guard launcherEngine != nil else { return }
    resourceZipImporterChannel?.invokeMethod(
      "incomingZipReceived",
      arguments: zip.url.lastPathComponent
    )
  }

  private func extractIncomingDocsZip(
    call: FlutterMethodCall,
    result: @escaping FlutterResult
  ) {
    guard let args = call.arguments as? [String: Any],
          let targetDirectory = args["targetDirectory"] as? String,
          !targetDirectory.isEmpty else {
      result(
        FlutterError(
          code: "invalid_target_directory",
          message: "缺少导入目标目录",
          details: nil
        )
      )
      return
    }
    guard !zipImportInProgress, pendingImportResult == nil else {
      result(
        FlutterError(
          code: "zip_import_busy",
          message: "已有资源导入正在进行",
          details: nil
        )
      )
      return
    }
    guard let zip = incomingZip else {
      result(nil)
      return
    }
    incomingZip = nil
    zipImportInProgress = true
    finishPickedZipImport(
      zipURL: zip.url,
      targetDirectory: targetDirectory
    ) { value in
      zip.discard()
      result(value)
    }
  }

  private func registerAppLogger(on messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(
      name: "io.github.dey410.gardendlessloader/app_logger",
      binaryMessenger: messenger
    )
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(nil)
        return
      }
      switch call.method {
      case "initialize":
        self.logStore.initialize()
        result(["appSessionId": self.logStore.appSessionId])
      case "emit":
        guard let event = call.arguments as? [String: Any] else {
          result(
            FlutterError(
              code: "invalid_log_event",
              message: "Log event must be a map",
              details: nil
            )
          )
          return
        }
        self.logStore.emit(event)
        result(nil)
      case "snapshot":
        let limit = (call.arguments as? [String: Any])?["limit"] as? Int ?? 500
        result(self.logStore.snapshot(limit: limit))
      case "flush":
        _ = self.logStore.flush(timeout: 0.5)
        result(nil)
      case "deleteHistory":
        self.logStore.deleteHistory()
        result(nil)
      case "endSession":
        self.logStore.endSession()
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func pickAndExtractDocsZip(
    call: FlutterMethodCall,
    result: @escaping FlutterResult
  ) {
    guard let args = call.arguments as? [String: Any],
          let targetDirectory = args["targetDirectory"] as? String,
          !targetDirectory.isEmpty else {
      result(
        FlutterError(
          code: "invalid_target_directory",
          message: "缺少导入目标目录",
          details: nil
        )
      )
      return
    }
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        result(
          FlutterError(
            code: "zip_picker_failed",
            message: "无法获取 iOS 应用代理",
            details: nil
          )
        )
        return
      }
      guard let rootController = self.topViewController() else {
        result(
          FlutterError(
            code: "zip_picker_failed",
            message: "Unable to present document picker",
            details: nil
          )
        )
        return
      }
      if self.zipImportInProgress || self.pendingImportResult != nil {
        result(
          FlutterError(
            code: "zip_import_busy",
            message: "已有资源导入选择正在进行",
            details: nil
          )
        )
        return
      }
      // Allow picking only standard .zip archives and Windows Tauri .exe binaries.
      // Crucial: do NOT include UTType.data or UTType.item, as those force iOS Files app
      // to crawl and index all 8,900+ extracted game assets inside Documents, freezing CPU.
      let exeType = UTType("com.microsoft.windows-executable")
        ?? UTType(filenameExtension: "exe")
        ?? UTType(tag: "exe", tagClass: .filenameExtension, conformingTo: .data)
      var contentTypes: [UTType] = [UTType.zip]
      if let exeType {
        contentTypes.append(exeType)
      }
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: contentTypes,
        asCopy: true
      )
      picker.delegate = self
      picker.allowsMultipleSelection = false
      picker.modalPresentationStyle = .formSheet
      self.zipImportInProgress = true
      self.pendingImportResult = result
      self.pendingImportTargetDirectory = targetDirectory
      rootController.present(picker, animated: true)
    }
  }

  private func finishPickedZipImport(
    zipURL: URL,
    targetDirectory: String,
    result: @escaping FlutterResult
  ) {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else {
        DispatchQueue.main.async {
          result(
            FlutterError(
              code: "zip_picker_failed",
              message: "无法获取 iOS 应用代理",
              details: nil
            )
          )
        }
        return
      }
      let didAccess = zipURL.startAccessingSecurityScopedResource()
      defer {
        if didAccess {
          zipURL.stopAccessingSecurityScopedResource()
        }
      }
      do {
        if Self.isWindowsExecutable(url: zipURL) {
          try self.runTauriExeImport(
            exeURL: zipURL,
            targetDirectory: targetDirectory
          )
        } else {
          let session = ZipImportSession(
            zipURL: zipURL,
            targetDirectory: URL(
              fileURLWithPath: targetDirectory,
              isDirectory: true
            )
          )
          _ = try session.run { [weak self] progress in
            self?.reportImportProgress(progress)
          }
        }
        DispatchQueue.main.async {
          self.zipImportInProgress = false
          result(targetDirectory)
        }
      } catch {
        DispatchQueue.main.async {
          self.zipImportInProgress = false
          result(
            FlutterError(
              code: Self.zipImportErrorCode(error),
              message: "无法导入选择的资源包：\(error.localizedDescription)",
              details: nil
            )
          )
        }
      }
    }
  }

  /// Checks whether the picked file is a Windows PE executable (`MZ` header or `.exe`).
  private static func isWindowsExecutable(url: URL) -> Bool {
    if let handle = try? FileHandle(forReadingFrom: url) {
      defer { try? handle.close() }
      if let data = try? handle.read(upToCount: 2),
         data.count == 2,
         data[0] == 0x4D,
         data[1] == 0x5A {
        return true
      }
    }
    return url.pathExtension.lowercased() == "exe"
  }

  /// Extracts embedded Brotli frontend assets from a Tauri Windows `.exe` via `tauri-dumper` FFI.
  private func runTauriExeImport(
    exeURL: URL,
    targetDirectory: String
  ) throws {
    let attributes = try FileManager.default.attributesOfItem(atPath: exeURL.path)
    let sourceBytes = (attributes[.size] as? NSNumber)?.int64Value ?? 0

    // Verify at least 2.5x the input .exe size in available storage before unpacking.
    if sourceBytes > 0 {
      let targetParent = URL(fileURLWithPath: targetDirectory).deletingLastPathComponent()
      let freeBytes = (try? targetParent.resourceValues(
        forKeys: [.volumeAvailableCapacityForImportantUsageKey]
      ).volumeAvailableCapacityForImportantUsage) ?? 0
      let requiredBytes = Int64(Double(sourceBytes) * 2.5)
      if freeBytes > 0 && freeBytes < requiredBytes {
        throw NSError(
          domain: "GardendlessTauriImport",
          code: -10,
          userInfo: [
            NSLocalizedDescriptionKey: "设备可用存储空间不足（解包 EXE 至少需要约 2.5 倍文件体积的剩余空间）"
          ]
        )
      }
    }

    reportImportProgress(
      ImportProgress(
        phase: "receiving",
        processedBytes: sourceBytes,
        totalBytes: sourceBytes,
        processedFiles: 0,
        totalFiles: 0,
        message: "正在解析 Tauri PE 可执行文件"
      ),
      force: true
    )

    let targetURL = URL(fileURLWithPath: targetDirectory, isDirectory: true)
    if FileManager.default.fileExists(atPath: targetURL.path) {
      let existing = (try? FileManager.default.contentsOfDirectory(
        at: targetURL,
        includingPropertiesForKeys: nil
      )) ?? []
      for item in existing {
        try FileManager.default.removeItem(at: item)
      }
    } else {
      try FileManager.default.createDirectory(
        at: targetURL,
        withIntermediateDirectories: true
      )
    }

    reportImportProgress(
      ImportProgress(
        phase: "extracting",
        processedBytes: 0,
        totalBytes: sourceBytes,
        processedFiles: 0,
        totalFiles: 0,
        message: "正在解压 EXE 内嵌 Brotli 资源"
      ),
      force: true
    )

    let exportedCount: Int32 = exeURL.path.withCString { exeCStr in
      targetDirectory.withCString { outCStr in
        gardendless_extract_tauri_exe(exeCStr, outCStr)
      }
    }

    guard exportedCount > 0 else {
      let reason: String
      switch exportedCount {
      case -2:
        reason = "无法读取或内存映射该 EXE 文件"
      case -3:
        reason = "该 EXE 不是有效的 Tauri 构建或未检测到内嵌资源表"
      case -4:
        reason = "解压内嵌 Brotli 资源失败，请确认文件完整且存储空间充足"
      case -5:
        reason = "从 EXE 解压出的资源中缺少 index.html"
      default:
        reason = "解包 Tauri EXE 失败（错误码 \(exportedCount)）"
      }
      throw NSError(
        domain: "GardendlessTauriImport",
        code: Int(exportedCount),
        userInfo: [NSLocalizedDescriptionKey: reason]
      )
    }

    reportImportProgress(
      ImportProgress(
        phase: "extracting",
        processedBytes: sourceBytes,
        totalBytes: sourceBytes,
        processedFiles: Int(exportedCount),
        totalFiles: Int(exportedCount),
        message: "已从 EXE 解压 \(exportedCount) 个资源文件"
      ),
      force: true
    )

    // Ensure gp-next support files exist in slot
    let targetDirURL = URL(fileURLWithPath: targetDirectory, isDirectory: true)
    let gpNextDirURL = targetDirURL.appendingPathComponent("gp-next", isDirectory: true)
    try? FileManager.default.createDirectory(at: gpNextDirURL, withIntermediateDirectories: true)
    let settingsSrc = targetDirURL.appendingPathComponent("src/settings.json")
    let settingsDst = gpNextDirURL.appendingPathComponent("settings.json")
    if !FileManager.default.fileExists(atPath: settingsDst.path),
       FileManager.default.fileExists(atPath: settingsSrc.path) {
      try? FileManager.default.copyItem(at: settingsSrc, to: settingsDst)
    }
    let directSettingsDst = targetDirURL.appendingPathComponent("settings.json")
    if !FileManager.default.fileExists(atPath: directSettingsDst.path),
       FileManager.default.fileExists(atPath: settingsSrc.path) {
      try? FileManager.default.copyItem(at: settingsSrc, to: directSettingsDst)
    }
  }

  /// Flutter error code naming the failure cause; it selects the launcher's fix hint.
  private static func zipImportErrorCode(_ error: Error) -> String {
    let nsError = error as NSError
    if nsError.domain == "GardendlessTauriImport" {
      switch nsError.code {
      case -3: return "zip_docs_missing"
      case -5: return "resource_missing_index"
      default: return "import_extract_failed"
      }
    }
    switch (error as? GameError)?.code {
    case .zipDocsMissing: return "zip_docs_missing"
    case .zipInvalid: return "zip_invalid"
    case .zipEncrypted: return "zip_encrypted"
    case .zipUnsupported: return "zip_unsupported"
    case .zipSymbolicLink, .zipPathUnsafe: return "zip_path_unsafe"
    case .zipWriteFailed: return "zip_write_failed"
    default: return "zip_import_failed"
    }
  }

  private func reportImportProgress(_ progress: ImportProgress, force: Bool = false) {
    let now = DispatchTime.now().uptimeNanoseconds
    if !force && now - lastImportProgressReportAt < 100_000_000 {
      return
    }
    lastImportProgressReportAt = now
    let arguments: [String: Any] = [
      "phase": progress.phase,
      "processedBytes": progress.processedBytes,
      "totalBytes": progress.totalBytes,
      "processedFiles": progress.processedFiles,
      "totalFiles": progress.totalFiles,
      "message": progress.message,
    ]
    DispatchQueue.main.async { [weak self] in
      self?.resourceZipImporterChannel?.invokeMethod(
        "progress",
        arguments: arguments
      )
    }
  }

  private func topViewController() -> UIViewController? {
    var controller = window?.rootViewController
    while let presented = controller?.presentedViewController {
      controller = presented
    }
    return controller
  }
}

/// A ZIP/EXE handed over by another app. A copy the system placed in the app's
/// Inbox belongs to the loader and is removed once used; a file opened in
/// place stays where it is.
private struct IncomingZip {
  let url: URL
  let isCopy: Bool

  func discard() {
    if isCopy {
      try? FileManager.default.removeItem(at: url)
    }
  }
}

// iOS 27 terminates apps built with its SDK unless they adopt the UIScene lifecycle.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let scene = scene as? UIWindowScene,
          let app = UIApplication.shared.delegate as? AppDelegate else { return }
    if let context = connectionOptions.urlContexts.first {
      app.receiveIncomingZip(context)
    }
    app.pendingShortcut = connectionOptions.shortcutItem?.type
    app.window = UIWindow(windowScene: scene)
    app.showLauncher()
  }

  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    (UIApplication.shared.delegate as? AppDelegate)?.performShortcut(shortcutItem.type)
    completionHandler(true)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let context = URLContexts.first,
          let app = UIApplication.shared.delegate as? AppDelegate else { return }
    app.receiveIncomingZip(context)
  }
}

extension AppDelegate: UIDocumentPickerDelegate {
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    guard let pendingImportResult else { return }
    pendingImportResult(nil)
    self.pendingImportResult = nil
    pendingImportTargetDirectory = nil
    zipImportInProgress = false
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController,
    didPickDocumentsAt urls: [URL]
  ) {
    guard let pendingImportResult else { return }
    let targetDirectory = pendingImportTargetDirectory
    self.pendingImportResult = nil
    pendingImportTargetDirectory = nil
    guard let zipURL = urls.first, let targetDirectory else {
      zipImportInProgress = false
      pendingImportResult(nil)
      return
    }
    finishPickedZipImport(
      zipURL: zipURL,
      targetDirectory: targetDirectory,
      result: pendingImportResult
    )
  }
}
