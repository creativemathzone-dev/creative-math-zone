package in.creativemathzone.cmz;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Prints a page (receipt, worksheet, QR cards, report) with Android's own Print screen,
 * which also offers "Save as PDF". The page's HTML is given by native.js in the portal.
 */
@CapacitorPlugin(name = "CmzPrint")
public class PrintPlugin extends Plugin {
    // Kept as a field so the off-screen page is not cleaned up before printing starts.
    private WebView printView;

    @PluginMethod
    public void printHtml(final PluginCall call) {
        final String html = call.getString("html", "");
        final String title = call.getString("title", "Creative Math Zone");
        if (html == null || html.isEmpty()) {
            call.reject("Nothing to print.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            printView = new WebView(getActivity());
            printView.getSettings().setJavaScriptEnabled(false);
            printView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(title);
                    manager.print(title, adapter, new PrintAttributes.Builder().build());
                    call.resolve();
                }
            });
            printView.loadDataWithBaseURL("https://creativemathzone.in/web/", html, "text/html", "UTF-8", null);
        });
    }
}
