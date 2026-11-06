package fj.kaitech.drivo.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import fj.kaitech.drivo.MainViewModel
import fj.kaitech.drivo.ui.components.Card
import fj.kaitech.drivo.ui.components.PrimaryButton
import fj.kaitech.drivo.ui.theme.Drivo

/**
 * Sign in with a KaiTech account (the same email works in BillZilla and
 * KaiWorkforce). "Continue as <name>" through KaiTech single sign-on is added
 * with the integrations milestone; see docs/decisions.md.
 */
@Composable
fun SignInScreen(vm: MainViewModel) {
    val ui by vm.ui.collectAsState()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Drivo", style = MaterialTheme.typography.labelLarge, color = Drivo.Navy)
        Text("Sign in", style = MaterialTheme.typography.headlineSmall)
        Text("Use your KaiTech account: the email your company added you with.", color = Drivo.Muted)
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
        ui.message?.let { Text(it, color = Drivo.Bad) }
        PrimaryButton(if (ui.loading) "Signing in" else "Sign in", { vm.signIn(email, password) }, Modifier.fillMaxWidth(), enabled = !ui.loading)
        Card {
            Text("About location sharing", style = MaterialTheme.typography.titleMedium)
            Text("Drivo shares your location with your dispatcher only while you are on shift: from clock-in to clock-out, or from starting your route until your last delivery. It is used for the live map, arrival at shops and speed alerts.", color = Drivo.Muted)
            Text("Android will ask to allow location all the time. Choose it so tracking keeps working with the screen off. It stops when your shift ends.", color = Drivo.Muted)
        }
    }
}
