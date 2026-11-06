import SwiftUI

/// KaiTech design tokens, shared with the web admin and the Android app.
enum DrivoColor {
    static let navy = Color(hex: 0x0B1F44)
    static let blue = Color(hex: 0x2563EB)
    static let ink = Color(hex: 0x0B1220)
    static let muted = Color(hex: 0x5D6B82)
    static let line = Color(hex: 0xE4E7EC)
    static let page = Color(hex: 0xF7F8FA)
    static let black = Color(hex: 0x0B0B0C)
    static let ok = Color(hex: 0x166534), okBg = Color(hex: 0xDCFCE7)
    static let bad = Color(hex: 0xB42318), badBg = Color(hex: 0xFEE4E2)
    static let warn = Color(hex: 0x93370D), warnBg = Color(hex: 0xFEF0C7)
    static let neutral = Color(hex: 0x344054), neutralBg = Color(hex: 0xEEF1F5)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// IBM Plex Sans with tabular figures, scaled with Dynamic Type.
extension Font {
    static func plex(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        let name = switch weight {
        case .semibold, .bold: "IBMPlexSans-SemiBold"
        case .medium: "IBMPlexSans-Medium"
        default: "IBMPlexSans-Regular"
        }
        return .custom(name, size: size, relativeTo: style).monospacedDigit()
    }
    static let drivoTitle = plex(22, .semibold, relativeTo: .title2)
    static let drivoHeading = plex(17, .semibold, relativeTo: .headline)
    static let drivoBody = plex(16)
    static let drivoSmall = plex(13, relativeTo: .footnote)
    static let drivoLabel = plex(15, .medium, relativeTo: .callout)
}
