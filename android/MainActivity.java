package com.bistryyarik.wfo;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.OutputStream;

public final class MainActivity extends Activity {
    private static final int SAVE_BUILD = 1;
    private static final int MAX_UPDATE_SIZE = 24 * 1024 * 1024;
    private byte[] pendingBuild;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView game = new WebView(this);
        game.getSettings().setJavaScriptEnabled(true);
        game.getSettings().setDomStorageEnabled(true);
        game.getSettings().setAllowContentAccess(false);
        game.getSettings().setAllowFileAccess(false);
        game.setWebChromeClient(new WebChromeClient());
        game.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri address = request.getUrl();
                if ("https".equals(address.getScheme()) && "raw.githubusercontent.com".equals(address.getHost())
                        && address.getPath() != null
                        && address.getPath().startsWith("/Bistry-Yarik/WFO/")) {
                    startActivity(new Intent(Intent.ACTION_VIEW, address));
                }
                return true;
            }
        });
        game.addJavascriptInterface(this, "WfoAndroid");
        setContentView(game);
        game.loadUrl("file:///android_asset/index.html");
    }

    @JavascriptInterface
    public void saveVerifiedBuild(String extension, String encoded) {
        if ((!"apk".equals(extension) && !"exe".equals(extension)) || encoded.length() > MAX_UPDATE_SIZE * 2) {
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException invalid) {
            return;
        }
        if (bytes.length > MAX_UPDATE_SIZE) return;
        runOnUiThread(() -> {
            if (pendingBuild != null) return;
            pendingBuild = bytes;
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            save.addCategory(Intent.CATEGORY_OPENABLE);
            save.setType("application/octet-stream");
            save.putExtra(Intent.EXTRA_TITLE, "WFO." + extension);
            startActivityForResult(save, SAVE_BUILD);
        });
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != SAVE_BUILD) return;
        byte[] bytes = pendingBuild;
        pendingBuild = null;
        if (result != RESULT_OK || data == null || bytes == null) return;
        try (OutputStream output = getContentResolver().openOutputStream(data.getData())) {
            if (output == null) throw new IOException("No output stream");
            output.write(bytes);
        } catch (IOException failure) {
            Toast.makeText(this, "Не удалось сохранить сборку WFO", Toast.LENGTH_LONG).show();
        }
    }
}
