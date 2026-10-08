// Development-only WKWebView transport regression bridge. Never app resources.
// Receives trusted test code on inherited stdin; only loopback HTTP navigation.
import AppKit
import Foundation
import WebKit

private func emit(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

@MainActor
private final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let web: WKWebView
    let window: NSWindow
    var navigationId: Int?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        web.navigationDelegate = self
        configuration.userContentController.add(self, name: "probe")
        window.title = "NearLink WKWebView 本机验证"
        window.contentView = web
        window.orderFront(nil)
    }

    func command(_ value: [String: Any]) {
        guard let id = value["id"] as? Int, let method = value["method"] as? String else { exit(2) }
        switch method {
        case "goto":
            guard navigationId == nil, let raw = value["url"] as? String, let url = URL(string: raw),
                  url.scheme == "http", url.host == "127.0.0.1", url.user == nil, url.password == nil else {
                emit(["id": id, "error": "LOOPBACK_URL_REQUIRED"]); return
            }
            navigationId = id
            web.load(URLRequest(url: url))
        case "evaluate":
            guard let code = value["code"] as? String, code.utf8.count <= 131_072 else {
                emit(["id": id, "error": "TEST_SCRIPT_LIMIT"]); return
            }
            web.callAsyncJavaScript("return (await (\(code))(argument)) ?? null;", arguments: ["argument": value["argument"] ?? NSNull()],
                                    in: nil, in: .page) { result in
                switch result {
                case .success(let result): emit(["id": id, "result": result])
                case .failure(let error): emit(["id": id, "error": String(describing: error)])
                }
            }
        case "focus":
            NSApplication.shared.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(web)
            emit(["id": id, "result": NSNull()])
        case "close":
            web.stopLoading()
            window.orderOut(nil)
            emit(["id": id, "result": NSNull()])
            NSApplication.shared.terminate(nil)
        default: emit(["id": id, "error": "UNKNOWN_TEST_METHOD"])
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any],
              let name = body["name"] as? String, name == "sendHostSignal" else { return }
        emit(["event": name, "argument": body["argument"] ?? NSNull()])
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.scheme == "http" && url?.host == "127.0.0.1" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let id = navigationId { navigationId = nil; emit(["id": id, "result": NSNull()]) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if let id = navigationId { navigationId = nil; emit(["id": id, "error": error.localizedDescription]) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { emit(["fatal": "WK_CONTENT_PROCESS_EXITED"]); exit(2) }
}

@main
struct Main {
    @MainActor static func main() {
        guard CommandLine.arguments.count == 1 else { exit(2) }
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let probe = Probe()
        DispatchQueue.global().async {
            while let line = readLine() {
                guard line.utf8.count <= 262_144, let data = line.data(using: .utf8),
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(2) }
                DispatchQueue.main.async { probe.command(value) }
            }
            DispatchQueue.main.async { app.terminate(nil) }
        }
        emit(["ready": true])
        app.run()
    }
}
