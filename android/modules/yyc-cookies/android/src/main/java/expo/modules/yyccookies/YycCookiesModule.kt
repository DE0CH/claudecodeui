package expo.modules.yyccookies

import android.graphics.Color
import android.view.View
import android.webkit.CookieManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.max

// The app's native bits (README.md):
// - the WebView's cookie jar (android.webkit.CookieManager, shared by every WebView in the app): the app puts the Access
//   token it got from the router's sign-in there as CF_Authorization, the cookie a browser would hold for the site;
// - the window insets: Android 15+ draws apps edge to edge and no longer shrinks the window for the keyboard
//   (adjustResize), so the activity's content view is padded by the system bars, the display cutout and the keyboard
//   itself. The WebView then ends above the keyboard and the page sees the smaller viewport, as in Chrome. The insets
//   are consumed there, so nothing below pads again.
class YycCookiesModule : Module() {
  private var background = Color.BLACK

  private fun content(): View? = appContext.currentActivity?.findViewById(android.R.id.content)

  private fun installInsets() {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread {
      val view = content() ?: return@runOnUiThread
      view.setBackgroundColor(background)
      ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        v.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
        WindowInsetsCompat.CONSUMED
      }
      ViewCompat.requestApplyInsets(view)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("YycCookies")

    OnCreate { installInsets() }
    OnActivityEntersForeground { installInsets() }

    AsyncFunction("set") { url: String, cookie: String, promise: Promise ->
      val jar = CookieManager.getInstance()
      jar.setAcceptCookie(true)
      jar.setCookie(url, cookie) { ok ->
        jar.flush()
        promise.resolve(ok)
      }
    }

    AsyncFunction("clear") { promise: Promise ->
      val jar = CookieManager.getInstance()
      jar.removeAllCookies { _ ->
        jar.flush()
        promise.resolve(null)
      }
    }

    // the colour behind the status bar, the navigation bar and a cutout (the page's own background around it)
    Function("setInsetsBackground") { color: String ->
      background = Color.parseColor(color)
      appContext.currentActivity?.runOnUiThread { content()?.setBackgroundColor(background) }
    }
  }
}
