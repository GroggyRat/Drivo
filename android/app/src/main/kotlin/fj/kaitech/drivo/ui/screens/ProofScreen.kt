package fj.kaitech.drivo.ui.screens

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.navigation.NavController
import fj.kaitech.drivo.MainViewModel
import fj.kaitech.drivo.data.ProofInput
import fj.kaitech.drivo.ui.components.Card
import fj.kaitech.drivo.ui.components.PrimaryButton
import fj.kaitech.drivo.ui.components.SecondaryButton
import fj.kaitech.drivo.ui.theme.Drivo
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Proof of delivery: the invoice lines from BillZilla, delivered in full,
 * a photo, the customer's signature, who received it, and a problem or a
 * partial delivery. Saved on the phone first; sent when there is signal.
 */
@Composable
fun ProofScreen(vm: MainViewModel, nav: NavController, stopId: String) {
    val context = LocalContext.current
    val ui by vm.ui.collectAsState()
    val route = ui.active ?: return
    val stop = route.stops.firstOrNull { it.id == stopId } ?: return
    val scope = rememberCoroutineScope()

    var inFull by remember { mutableStateOf(true) }
    var problem by remember { mutableStateOf(false) }
    var receivedBy by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var photo by remember { mutableStateOf<File?>(null) }
    val strokes = remember { mutableStateListOf<List<Offset>>() }
    var current by remember { mutableStateOf<List<Offset>>(emptyList()) }
    var padSize by remember { mutableStateOf(androidx.compose.ui.geometry.Size.Zero) }
    var saving by remember { mutableStateOf(false) }

    val photoFile = remember { File(context.cacheDir, "proof/$stopId-photo.jpg").apply { parentFile?.mkdirs() } }
    val photoUri: Uri = remember { FileProvider.getUriForFile(context, "fj.kaitech.drivo.files", photoFile) }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) photo = photoFile }

    val outcome = when {
        problem -> "failed"
        inFull -> "delivered"
        else -> "partially_delivered"
    }
    val canComplete = !saving && when (outcome) {
        "failed" -> notes.isNotBlank()
        "partially_delivered" -> notes.isNotBlank() && receivedBy.isNotBlank()
        else -> receivedBy.isNotBlank()
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Proof of delivery", style = MaterialTheme.typography.headlineSmall)
        Text("${stop.location.name}${stop.order?.let { ", ${it.reference}" } ?: ""}", color = Drivo.Muted)

        stop.order?.let { order ->
            Card {
                Text("Invoice lines", style = MaterialTheme.typography.titleMedium)
                order.lineItems.forEach { li ->
                    Row(Modifier.fillMaxWidth()) {
                        Text(li.description, Modifier.weight(1f))
                        Text("${li.quantity.let { if (it % 1.0 == 0.0) it.toInt().toString() else it.toString() }} ${li.unit ?: ""}".trim())
                    }
                }
                Text("${order.cartons} cartons", color = Drivo.Muted)
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = inFull && !problem, onCheckedChange = { inFull = it }, enabled = !problem)
            Text("Delivered in full")
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected = problem, onClick = { problem = !problem })
            Text("Report a problem: not delivered")
        }
        if (!inFull || problem) {
            OutlinedTextField(notes, { notes = it }, label = { Text(if (problem) "What happened" else "What was short or returned") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
        }
        if (!problem) {
            OutlinedTextField(receivedBy, { receivedBy = it }, label = { Text("Received by") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        }

        Card {
            Text("Photo", style = MaterialTheme.typography.titleMedium)
            Text(if (photo != null) "Photo taken." else "Take a photo of the goods at the shop.", color = Drivo.Muted)
            SecondaryButton(if (photo != null) "Take again" else "Take photo", { takePhoto.launch(photoUri) })
        }

        if (!problem) {
            Card {
                Text("Signature", style = MaterialTheme.typography.titleMedium)
                Canvas(
                    Modifier.fillMaxWidth().height(160.dp)
                        .background(Color.White, RoundedCornerShape(8.dp)).border(1.dp, Drivo.Line, RoundedCornerShape(8.dp))
                        .semantics { contentDescription = "Signature pad. Ask the customer to sign with a finger." }
                        .pointerInput(Unit) {
                            detectDragGestures(
                                onDragStart = { current = listOf(it) },
                                onDrag = { change, _ -> current = current + change.position },
                                onDragEnd = { strokes.add(current); current = emptyList() },
                            )
                        },
                ) {
                    padSize = size
                    (strokes + listOf(current)).filter { it.size > 1 }.forEach { pts ->
                        val path = Path().apply { moveTo(pts[0].x, pts[0].y); pts.drop(1).forEach { lineTo(it.x, it.y) } }
                        drawPath(path, Drivo.Navy, style = Stroke(width = 4f))
                    }
                }
                SecondaryButton("Clear signature", { strokes.clear() })
            }
        }

        PrimaryButton(if (saving) "Saving" else "Complete delivery", {
            saving = true
            scope.launch {
                val fix = currentLocation(context)
                vm.complete(route, stop, ProofInput(
                    outcome = outcome,
                    receivedBy = receivedBy.trim().ifBlank { null },
                    notes = notes.trim().ifBlank { null },
                    photo = photo,
                    signaturePng = if (strokes.isNotEmpty() && !problem) signaturePng(strokes, padSize) else null,
                    lon = fix?.longitude, lat = fix?.latitude, accuracyM = fix?.accuracy?.toDouble(),
                ))
                nav.navigate("run") { popUpTo("run") { inclusive = true } }
            }
        }, Modifier.fillMaxWidth(), enabled = canComplete)
        if (!canComplete && !saving) Text(if (problem) "Say what happened." else "Enter who received the goods.", color = Drivo.Muted)
    }
}

private fun signaturePng(strokes: List<List<Offset>>, size: androidx.compose.ui.geometry.Size): ByteArray {
    val w = size.width.toInt().coerceAtLeast(1)
    val h = size.height.toInt().coerceAtLeast(1)
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp).apply { drawColor(android.graphics.Color.WHITE) }
    val paint = Paint().apply { color = 0xFF0B1F44.toInt(); strokeWidth = 4f; style = Paint.Style.STROKE; isAntiAlias = true }
    strokes.filter { it.size > 1 }.forEach { pts -> pts.zipWithNext { a, b -> canvas.drawLine(a.x, a.y, b.x, b.y, paint) } }
    return ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
}
