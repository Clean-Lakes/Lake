import ObjectiveC.runtime
import WebKit

@MainActor func makeWorkbenchWebConfiguration() -> WKWebViewConfiguration {
    let configuration = WKWebViewConfiguration()
    preferDisplayRefreshRate(configuration.preferences)
    return configuration
}

// WebKit issue 294338 tracks a public opt-in for this preference. Look up the
// feature in the installed WebKit and leave its defaults in effect if it is absent.
@MainActor private func preferDisplayRefreshRate(_ preferences: WKPreferences) {
    let listSelector = NSSelectorFromString("_features")
    let keySelector = NSSelectorFromString("key")
    let enableSelector = NSSelectorFromString("_setEnabled:forFeature:")
    guard let listMethod = class_getClassMethod(WKPreferences.self, listSelector),
          let enableMethod = class_getInstanceMethod(WKPreferences.self, enableSelector) else { return }

    typealias ListFeatures = @convention(c) (AnyObject, Selector) -> Unmanaged<NSArray>?
    let list = unsafeBitCast(method_getImplementation(listMethod), to: ListFeatures.self)
    guard let features = list(WKPreferences.self as AnyObject, listSelector)?.takeUnretainedValue() as? [NSObject],
          let limit = features.first(where: { feature in
              feature.responds(to: keySelector) &&
              feature.perform(keySelector)?.takeUnretainedValue() as? String == "PreferPageRenderingUpdatesNear60FPSEnabled"
          }) else { return }

    typealias SetFeature = @convention(c) (AnyObject, Selector, ObjCBool, AnyObject) -> Void
    let setEnabled = unsafeBitCast(method_getImplementation(enableMethod), to: SetFeature.self)
    setEnabled(preferences, enableSelector, ObjCBool(false), limit)
}
