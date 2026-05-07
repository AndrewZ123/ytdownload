import UIKit
import Capacitor
import AVFoundation
import MediaPlayer

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("Failed to set audio session category: \(error)")
        }
        setupRemoteCommandCenter()
        return true
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

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
