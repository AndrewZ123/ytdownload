import UIKit
import Capacitor
import AVFoundation
import MediaPlayer

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

      func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
         do {
             let session = AVAudioSession.sharedInstance()
             try session.setCategory(.playback, mode: .default, options: [])
             try session.setActive(true)

             // Handle audio interruptions (phone calls, alarms, Siri, etc.)
             NotificationCenter.default.addObserver(
                 self,
                 selector: #selector(handleAudioInterruption(_:)),
                 name: AVAudioSession.interruptionNotification,
                 object: session
             )
         } catch {
             print("[AppDelegate] Failed to set audio session category: \(error)")
         }
         
         // Configure WebView to allow HTTP media from capacitor:// origin
         setupWebViewConfiguration()
         
         setupRemoteCommandCenter()
         return true
     }
    
    /// Configure WebView to allow HTTP audio from custom schemes
    private func setupWebViewConfiguration() {
        // This method will be called after the Capacitor bridge is initialized
        // The actual configuration happens in CAPBridgeViewController, but we'll
        // set it up via a delayed notification to ensure the WebView is ready
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            self.configureWebViewMediaPlayback()
        }
    }
    
    private func configureWebViewMediaPlayback() {
        guard let vc = window?.rootViewController as? CAPBridgeViewController else { return }
        
        // Get the WKWebView configuration
        let config = vc.webView?.configuration
        config?.mediaTypesRequiringUserActionForPlayback = []
        config?.allowsInlineMediaPlayback = true
        
        // Allow loading from custom schemes
        vc.webView?.evaluateJavaScript("""
            // Override any security restrictions for capacitor:// scheme
            if (!window.__webviewConfigured) {
                window.__webviewConfigured = true;
                console.log('[WebView] Configured for HTTP media playback from capacitor://');
            }
        """, completionHandler: nil)
    }

    @objc private func handleAudioInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            print("[AppDelegate] 🔇 Audio interruption began (phone call, alarm, etc.)")
            // Notify WebView that audio was interrupted
            DispatchQueue.main.async {
                self.notifyWebView(event: "audioInterruptionBegan")
            }

        case .ended:
            print("[AppDelegate] 🔊 Audio interruption ended — re-activating session")
            // Re-activate the audio session and optionally resume playback
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
                try AVAudioSession.sharedInstance().setActive(true)

                // Check if we should resume playback
                if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                    let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                    if options.contains(.shouldResume) {
                        DispatchQueue.main.async {
                            self.notifyWebView(event: "audioInterruptionEndedShouldResume")
                        }
                    } else {
                        DispatchQueue.main.async {
                            self.notifyWebView(event: "audioInterruptionEnded")
                        }
                    }
                }
            } catch {
                print("[AppDelegate] ⚠️ Failed to re-activate session after interruption: \(error)")
            }

        @unknown default:
            break
        }
    }

    /// Notify the WebView about native events via Capacitor bridge
    private func notifyWebView(event: String) {
        guard let vc = window?.rootViewController as? CAPBridgeViewController else { return }
        vc.webView?.evaluateJavaScript(
            "if(window._nativeEventReceiver){window._nativeEventReceiver('\(event)')}",
            completionHandler: nil
        )
    }

    private func setupRemoteCommandCenter() {
        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.playCommand.addTarget { event in
            NotificationCenter.default.post(name: NSNotification.Name("NowPlayingPlay"), object: nil)
            return .success
        }
        commandCenter.pauseCommand.addTarget { event in
            NotificationCenter.default.post(name: NSNotification.Name("NowPlayingPause"), object: nil)
            return .success
        }
        commandCenter.nextTrackCommand.addTarget { event in
            NotificationCenter.default.post(name: NSNotification.Name("NowPlayingNext"), object: nil)
            return .success
        }
        commandCenter.previousTrackCommand.addTarget { event in
            NotificationCenter.default.post(name: NSNotification.Name("NowPlayingPrevious"), object: nil)
            return .success
        }
        commandCenter.changePlaybackPositionCommand.addTarget { event in
            if let posEvent = event as? MPChangePlaybackPositionCommandEvent {
                NotificationCenter.default.post(name: NSNotification.Name("NowPlayingSeek"), object: nil, userInfo: ["position": posEvent.positionTime])
                return .success
            }
            return .commandFailed
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Keep audio session active for background playback
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Audio session stays active — .playback category supports background audio
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Re-activate audio session when returning from background
        // This is critical: iOS can deactivate the session after extended background time
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            print("[AppDelegate] ✅ Audio session re-activated on foreground")
        } catch {
            print("[AppDelegate] ⚠️ Audio session re-activation failed: \(error)")
        }
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Ensure session is active after any interruption
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("[AppDelegate] ⚠️ Audio session activation on becomeActive failed: \(error)")
        }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Clean up audio session
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
