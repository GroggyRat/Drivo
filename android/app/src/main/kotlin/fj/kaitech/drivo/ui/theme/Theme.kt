package fj.kaitech.drivo.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape
import fj.kaitech.drivo.R

/** KaiTech design tokens, shared with the web admin. */
object Drivo {
    val Navy = Color(0xFF0B1F44)
    val Blue = Color(0xFF2563EB)
    val Ink = Color(0xFF0B1220)
    val Muted = Color(0xFF5D6B82)
    val Line = Color(0xFFE4E7EC)
    val Page = Color(0xFFF7F8FA)
    val Black = Color(0xFF0B0B0C)
    val Ok = Color(0xFF166534); val OkBg = Color(0xFFDCFCE7)
    val Bad = Color(0xFFB42318); val BadBg = Color(0xFFFEE4E2)
    val Warn = Color(0xFF93370D); val WarnBg = Color(0xFFFEF0C7)
    val Neutral = Color(0xFF344054); val NeutralBg = Color(0xFFEEF1F5)
}

val PlexSans = FontFamily(
    Font(R.font.ibm_plex_sans_regular, FontWeight.Normal),
    Font(R.font.ibm_plex_sans_medium, FontWeight.Medium),
    Font(R.font.ibm_plex_sans_semibold, FontWeight.SemiBold),
)

/** Tabular figures, so times and distances line up. */
private fun style(size: Int, weight: FontWeight, line: Int) =
    TextStyle(fontFamily = PlexSans, fontWeight = weight, fontSize = size.sp, lineHeight = line.sp, fontFeatureSettings = "tnum")

@Composable
fun DrivoTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Drivo.Black, onPrimary = Color.White,
            secondary = Drivo.Blue, background = Drivo.Page, surface = Color.White,
            onSurface = Drivo.Ink, onBackground = Drivo.Ink, outline = Drivo.Line, error = Drivo.Bad,
        ),
        typography = Typography(
            headlineSmall = style(22, FontWeight.SemiBold, 28),
            titleMedium = style(17, FontWeight.SemiBold, 24),
            bodyLarge = style(16, FontWeight.Normal, 24),
            bodyMedium = style(15, FontWeight.Normal, 22),
            bodySmall = style(13, FontWeight.Normal, 18),
            labelLarge = style(15, FontWeight.Medium, 20),
            labelSmall = style(12, FontWeight.Medium, 16),
        ),
        shapes = Shapes(small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(10.dp), large = RoundedCornerShape(10.dp)),
        content = content,
    )
}
