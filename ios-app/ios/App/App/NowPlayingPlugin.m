#import <Capacitor/Capacitor.h>

// Define the plugin using the CAP_PLUGIN Macro
CAP_PLUGIN(NowPlayingPlugin, "NowPlaying",
    CAP_PLUGIN_METHOD(updateNowPlaying, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(clearNowPlaying, CAPPluginReturnPromise);
)