package fj.kaitech.drivo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import fj.kaitech.drivo.ui.screens.AccountScreen
import fj.kaitech.drivo.ui.screens.ArrivedScreen
import fj.kaitech.drivo.ui.screens.DropPinScreen
import fj.kaitech.drivo.ui.screens.LedgerScreen
import fj.kaitech.drivo.ui.screens.MapScreen
import fj.kaitech.drivo.ui.screens.NavigationScreen
import fj.kaitech.drivo.ui.screens.ProofScreen
import fj.kaitech.drivo.ui.screens.RunScreen
import fj.kaitech.drivo.ui.screens.SignInScreen
import fj.kaitech.drivo.ui.theme.Drivo
import fj.kaitech.drivo.ui.theme.DrivoTheme

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            DrivoTheme {
                val ui by vm.ui.collectAsState()
                if (!ui.signedIn) SignInScreen(vm) else DriverApp(vm)
            }
        }
    }
}

private data class Tab(val route: String, val label: String, val icon: Int)

private val TABS = listOf(
    Tab("run", "Run", android.R.drawable.ic_menu_agenda),
    Tab("map", "Map", android.R.drawable.ic_menu_mapmode),
    Tab("ledger", "Ledger", android.R.drawable.ic_menu_sort_by_size),
    Tab("pin", "Drop pin", android.R.drawable.ic_menu_mylocation),
    Tab("account", "Account", android.R.drawable.ic_menu_myplaces),
)

/** Bottom tabs on every driver screen: Run, Map, Ledger, Drop pin, Account. */
@Composable
private fun DriverApp(vm: MainViewModel) {
    val nav = rememberNavController()
    Scaffold(bottomBar = { BottomTabs(nav) }) { padding ->
        NavHost(nav, startDestination = "run", modifier = Modifier.padding(padding)) {
            composable("run") { RunScreen(vm, nav) }
            composable("map") { MapScreen(vm) }
            composable("ledger") { LedgerScreen(vm) }
            composable("pin") { DropPinScreen(vm) }
            composable("account") { AccountScreen(vm) }
            composable("navigate/{stopId}") { NavigationScreen(vm, nav, it.arguments?.getString("stopId")!!) }
            composable("arrived/{stopId}") { ArrivedScreen(vm, nav, it.arguments?.getString("stopId")!!) }
            composable("proof/{stopId}") { ProofScreen(vm, nav, it.arguments?.getString("stopId")!!) }
        }
    }
}

@Composable
private fun BottomTabs(nav: NavHostController) {
    val current by nav.currentBackStackEntryAsState()
    NavigationBar(containerColor = Color.White) {
        TABS.forEach { tab ->
            NavigationBarItem(
                selected = current?.destination?.route == tab.route,
                onClick = { nav.navigate(tab.route) { popUpTo("run"); launchSingleTop = true } },
                icon = { Icon(painterResource(tab.icon), contentDescription = null) },
                label = { Text(tab.label) },
                colors = NavigationBarItemDefaults.colors(selectedIconColor = Drivo.Blue, selectedTextColor = Drivo.Ink, indicatorColor = Drivo.NeutralBg),
            )
        }
    }
}
