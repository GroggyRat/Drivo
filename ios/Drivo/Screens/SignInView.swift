import SwiftUI

/// Sign in with a KaiTech account (the same email works in BillZilla and
/// KaiWorkforce). "Continue as <name>" through KaiTech single sign-on comes
/// with the integrations work; see docs/decisions.md.
struct SignInView: View {
    @EnvironmentObject var model: AppModel
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Drivo").font(.drivoLabel).foregroundStyle(DrivoColor.navy)
                Text("Sign in").font(.drivoTitle)
                Text("Use your KaiTech account: the email your company added you with.").foregroundStyle(DrivoColor.muted)
                TextField("Email", text: $email)
                    .textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(12).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .padding(12).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DrivoColor.line))
                if let m = model.message { Text(m).foregroundStyle(DrivoColor.bad) }
                PrimaryButton(title: model.loading ? "Signing in" : "Sign in", enabled: !model.loading && !email.isEmpty && !password.isEmpty) {
                    Task { await model.signIn(email: email, password: password) }
                }
                Panel {
                    Text("About location sharing").font(.drivoHeading)
                    Text("Drivo shares your location with your dispatcher only while you are on shift: from clock-in to clock-out, or from starting your route until your last delivery. It is used for the live map, arrival at shops and speed alerts.").foregroundStyle(DrivoColor.muted)
                    Text("iPhone will ask to allow location. Choose Allow While Using App, then Change to Always Allow when asked, so tracking keeps working with the screen off. It stops when your shift ends.").foregroundStyle(DrivoColor.muted)
                }
            }
            .padding(24)
        }
        .background(DrivoColor.page)
    }
}
