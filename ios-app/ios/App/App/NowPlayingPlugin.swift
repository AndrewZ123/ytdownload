import Foundation
import Capacitor
import MediaPlayer

@objc(NowPlayingPlugin)
public class NowPlayingPlugin: CAPPlugin {
    
    private var artworkImage: UIImage? = nil
    
    @objc func updateNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "Unknown"
        let artist = call.getString("artist") ?? "Unknown Artist"
        let album = call.getString("album") ?? ""
        let duration = call.getDouble("duration") ?? 0
        let elapsed = call.getDouble("elapsed") ?? 0
        let isPlaying = call.getBool("isPlaying") ?? true
        let artworkUrl = call.getString("artworkUrl") ?? ""
        
        DispatchQueue.main.async {
            let center = MPNowPlayingInfoCenter.default()
            var info: [String: Any] = [
                MPMediaItemPropertyTitle: title,
                MPMediaItemPropertyArtist: artist,
                MPMediaItemPropertyAlbumTitle: album,
                MPMediaItemPropertyPlaybackDuration: duration,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
                MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0
            ]
            
            if let url = URL(string: artworkUrl), artworkUrl.count > 0 {
                // Load artwork asynchronously to avoid blocking
                URLSession.shared.dataTask(with: url) { data, _, _ in
                    if let data = data, let img = UIImage(data: data) {
                        let artwork = MPMediaItemArtwork(boundsSize: CGSize(width: 512, height: 512)) { _ in img }
                        info[MPMediaItemPropertyArtwork] = artwork
                        DispatchQueue.main.async {
                            center.nowPlayingInfo = info
                        }
                    }
                }.resume()
            }
            
            center.nowPlayingInfo = info
            call.resolve()
        }
    }
    
    @objc func clearNowPlaying(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            call.resolve()
        }
    }
}