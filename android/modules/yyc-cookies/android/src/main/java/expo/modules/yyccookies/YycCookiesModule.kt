package expo.modules.yyccookies

import android.webkit.CookieManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The WebView's cookie jar (android.webkit.CookieManager, shared by every WebView in the app): the app puts the Access
// token it got from the router's sign-in there as CF_Authorization, the cookie a browser would hold for the site.
class YycCookiesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("YycCookies")

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
  }
}
