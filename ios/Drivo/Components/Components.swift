import SwiftUI

/// Black primary button, at least 48 pt tall.
struct PrimaryButton: View {
    let title: String
    var enabled = true
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.drivoLabel).frame(maxWidth: .infinity, minHeight: 48)
        }
        .foregroundStyle(.white)
        .background(enabled ? DrivoColor.black : DrivoColor.muted, in: RoundedRectangle(cornerRadius: 8))
        .disabled(!enabled)
    }
}

/// White secondary button with a 1 pt grey border.
struct SecondaryButton: View {
    let title: String
    var enabled = true
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.drivoLabel).frame(maxWidth: .infinity, minHeight: 48)
        }
        .foregroundStyle(enabled ? DrivoColor.ink : DrivoColor.muted)
        .background(.white, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
        .disabled(!enabled)
    }
}

enum Tone {
    case green, red, amber, grey
    var colors: (Color, Color) {
        switch self {
        case .green: (DrivoColor.ok, DrivoColor.okBg)
        case .red: (DrivoColor.bad, DrivoColor.badBg)
        case .amber: (DrivoColor.warn, DrivoColor.warnBg)
        case .grey: (DrivoColor.neutral, DrivoColor.neutralBg)
        }
    }
}

struct Badge: View {
    let text: String
    let tone: Tone
    var body: some View {
        Text(text).font(.plex(12, .medium, relativeTo: .caption))
            .foregroundStyle(tone.colors.0)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(tone.colors.1, in: Capsule())
    }
}

func stopBadge(_ status: String) -> (String, Tone) {
    switch status {
    case "delivered": ("Delivered", .green)
    case "partially_delivered": ("Part delivered", .amber)
    case "failed": ("Not delivered", .red)
    case "arrived": ("Arrived", .grey)
    case "skipped": ("Skipped", .grey)
    default: ("Scheduled", .grey)
    }
}

struct Panel<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.white, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(DrivoColor.line))
    }
}

/// Current speed beside the speed limit. Red once over the limit for the alert time.
struct SpeedReadout: View {
    let speedKmh: Int
    let limitKmh: Int?
    let alert: Bool
    var body: some View {
        HStack(spacing: 8) {
            VStack(spacing: 0) {
                Text("\(speedKmh)").font(.drivoTitle)
                Text("km/h").font(.plex(12, relativeTo: .caption))
            }
            .foregroundStyle(alert ? .white : DrivoColor.ink)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(alert ? DrivoColor.bad : .white, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(DrivoColor.line))
            if let limitKmh {
                Text("\(limitKmh)").font(.drivoHeading).foregroundStyle(DrivoColor.ink)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(.white))
                    .overlay(Circle().stroke(DrivoColor.bad, lineWidth: 4))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Speed \(speedKmh) kilometres an hour" + (limitKmh.map { ", limit \($0)" } ?? ""))
    }
}

func fijiTime(_ date: Date?) -> String {
    guard let date else { return "" }
    let f = DateFormatter()
    f.timeZone = Config.fiji
    f.dateFormat = "HH:mm"
    return f.string(from: date)
}
