import Foundation

/// Settings from Config.xcconfig, through Info.plist.
enum Config {
    private static func value(_ key: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? ""
    }
    static let supabaseURL = URL(string: value("DRIVO_SUPABASE_URL")) ?? URL(string: "http://localhost:54321")!
    static let supabaseKey = value("DRIVO_SUPABASE_KEY")
    static let webURL = URL(string: value("DRIVO_WEB_URL")) ?? URL(string: "http://localhost:3000")!
    static let mapStyleURL = URL(string: value("DRIVO_MAP_STYLE_URL")) ?? URL(string: "https://tiles.openfreemap.org/styles/liberty")!
    static let fiji = TimeZone(identifier: "Pacific/Fiji")!
}
