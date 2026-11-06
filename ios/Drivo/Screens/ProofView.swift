import SwiftUI
import UIKit

/// Proof of delivery: the invoice lines from BillZilla, delivered in full, a
/// photo, the customer's signature, who received it, and a problem or a part
/// delivery. Saved on the phone first; sent when there is signal.
struct ProofView: View {
    let stopId: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var tracker: LocationTracker
    @Environment(\.dismiss) private var dismiss

    @State private var inFull = true
    @State private var problem = false
    @State private var receivedBy = ""
    @State private var notes = ""
    @State private var photo: UIImage?
    @State private var showCamera = false
    @State private var strokes: [[CGPoint]] = []
    @State private var current: [CGPoint] = []
    @State private var saving = false

    private var outcome: String { problem ? "failed" : (inFull ? "delivered" : "partially_delivered") }
    private var canComplete: Bool {
        guard !saving else { return false }
        switch outcome {
        case "failed": return !notes.trimmingCharacters(in: .whitespaces).isEmpty
        case "partially_delivered": return !notes.trimmingCharacters(in: .whitespaces).isEmpty && !receivedBy.trimmingCharacters(in: .whitespaces).isEmpty
        default: return !receivedBy.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    var body: some View {
        if let route = model.active, let stop = route.stops.first(where: { $0.id == stopId }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("\(stop.location.name)\(stop.order.map { ", \($0.reference)" } ?? "")").foregroundStyle(DrivoColor.muted)
                    if let order = stop.order {
                        Panel {
                            Text("Invoice lines").font(.drivoHeading)
                            ForEach(order.lineItems, id: \.self) { li in
                                HStack {
                                    Text(li.description)
                                    Spacer()
                                    Text("\(li.quantity.formatted()) \(li.unit ?? "")")
                                }
                            }
                            Text("\(order.cartons) cartons").foregroundStyle(DrivoColor.muted)
                        }
                    }
                    Toggle("Delivered in full", isOn: $inFull).disabled(problem)
                    Toggle("Report a problem: not delivered", isOn: $problem)
                    if !inFull || problem {
                        TextField(problem ? "What happened" : "What was short or returned", text: $notes, axis: .vertical)
                            .lineLimit(2...4).padding(12).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
                    }
                    if !problem {
                        TextField("Received by", text: $receivedBy)
                            .textContentType(.name).padding(12).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
                    }
                    Panel {
                        Text("Photo").font(.drivoHeading)
                        if let photo { Image(uiImage: photo).resizable().scaledToFit().frame(maxHeight: 180).clipShape(RoundedRectangle(cornerRadius: 8)) }
                        else { Text("Take a photo of the goods at the shop.").foregroundStyle(DrivoColor.muted) }
                        SecondaryButton(title: photo == nil ? "Take photo" : "Take again") { showCamera = true }
                    }
                    if !problem {
                        Panel {
                            Text("Signature").font(.drivoHeading)
                            SignaturePad(strokes: $strokes, current: $current)
                            SecondaryButton(title: "Clear signature") { strokes = [] }
                        }
                    }
                    PrimaryButton(title: saving ? "Saving" : "Complete delivery", enabled: canComplete) {
                        saving = true
                        Task {
                            await model.complete(route: route, stop: stop, proof: ProofInput(
                                outcome: outcome,
                                receivedBy: receivedBy.trimmingCharacters(in: .whitespaces).isEmpty ? nil : receivedBy,
                                notes: notes.trimmingCharacters(in: .whitespaces).isEmpty ? nil : notes,
                                photo: photo?.jpegData(compressionQuality: 0.7),
                                signaturePNG: problem || strokes.isEmpty ? nil : SignaturePad.png(strokes),
                                lon: tracker.lastFix?.lon, lat: tracker.lastFix?.lat, accuracyM: tracker.lastFix?.accuracyM
                            ))
                            dismiss()
                        }
                    }
                    if !canComplete && !saving {
                        Text(problem ? "Say what happened." : "Enter who received the goods.").foregroundStyle(DrivoColor.muted)
                    }
                }
                .padding(16)
            }
            .background(DrivoColor.page)
            .navigationTitle("Proof of delivery")
            .sheet(isPresented: $showCamera) { CameraPicker(image: $photo).ignoresSafeArea() }
        }
    }
}

struct SignaturePad: View {
    @Binding var strokes: [[CGPoint]]
    @Binding var current: [CGPoint]
    static let size = CGSize(width: 340, height: 160)

    var body: some View {
        Canvas { ctx, _ in
            for line in strokes + [current] where line.count > 1 {
                var path = Path()
                path.addLines(line)
                ctx.stroke(path, with: .color(DrivoColor.navy), lineWidth: 3)
            }
        }
        .frame(height: Self.size.height)
        .background(.white)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { current.append($0.location) }
            .onEnded { _ in strokes.append(current); current = [] })
        .accessibilityLabel("Signature pad. Ask the customer to sign with a finger.")
    }

    static func png(_ strokes: [[CGPoint]]) -> Data? {
        UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            UIColor(DrivoColor.navy).setStroke()
            for line in strokes where line.count > 1 {
                let p = UIBezierPath()
                p.lineWidth = 3
                p.move(to: line[0])
                line.dropFirst().forEach { p.addLine(to: $0) }
                p.stroke()
            }
        }.pngData()
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.image = (info[.originalImage] as? UIImage).map(Self.shrink)
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }

        /// Photos are shrunk to 1600 px on the phone before upload.
        static func shrink(_ image: UIImage) -> UIImage {
            let longest = max(image.size.width, image.size.height)
            guard longest > 1600 else { return image }
            let scale = 1600 / longest
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        }
    }
}
