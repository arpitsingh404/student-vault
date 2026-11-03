package com.insafe.studentvault;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER = 1001;
    private WebView webView;
    private LocalServer server;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        );

        server = new LocalServer(getAssets());
        server.start();

        WebView.setWebContentsDebuggingEnabled(true);
        webView = new WebView(this);
        setContentView(webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.addJavascriptInterface(new NativeVault(), "NativeVault");
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/pdf", "image/*", "text/plain", "application/json"
                });
                try {
                    startActivityForResult(intent, FILE_CHOOSER);
                    return true;
                } catch (Exception error) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        webView.loadUrl("http://127.0.0.1:" + server.getPort() + "/");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER || filePathCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[]{data.getData()};
        }
        filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    public class NativeVault {
        @JavascriptInterface
        public String saveFile(String name, String base64, String mime) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String safeName = sanitize(name);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mime == null ? "application/octet-stream" : mime);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/StudentVault");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) return "error:insert";
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) return "error:stream";
                        out.write(bytes);
                        out.flush();
                    }
                    return "ok:" + uri;
                }
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "StudentVault");
                if (!dir.exists() && !dir.mkdirs()) return "error:mkdir";
                File file = new File(dir, safeName);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                return "ok:" + file.getAbsolutePath();
            } catch (Exception error) {
                return "error:" + error.getClass().getSimpleName();
            }
        }

        private String sanitize(String name) {
            String value = name == null ? "student-vault.svault" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
            return value.length() == 0 ? "student-vault.svault" : value;
        }
    }

    private static class LocalServer implements Runnable {
        private final AssetManager assets;
        private ServerSocket socket;
        private Thread thread;
        private volatile boolean running = true;
        private final Map<String, String> mime = new HashMap<>();

        LocalServer(AssetManager assets) {
            this.assets = assets;
            mime.put("html", "text/html; charset=utf-8");
            mime.put("css", "text/css; charset=utf-8");
            mime.put("js", "application/javascript; charset=utf-8");
            mime.put("json", "application/json; charset=utf-8");
            mime.put("pdf", "application/pdf");
            mime.put("png", "image/png");
            mime.put("jpg", "image/jpeg");
            mime.put("jpeg", "image/jpeg");
            mime.put("webp", "image/webp");
            mime.put("gif", "image/gif");
            mime.put("svg", "image/svg+xml");
            mime.put("txt", "text/plain; charset=utf-8");
        }

        void start() {
            thread = new Thread(this, "student-vault-assets");
            thread.start();
            for (int i = 0; i < 100 && socket == null; i++) {
                try { Thread.sleep(10); } catch (InterruptedException ignored) {}
            }
        }

        int getPort() {
            return socket == null ? 47123 : socket.getLocalPort();
        }

        void stop() {
            running = false;
            try { if (socket != null) socket.close(); } catch (Exception ignored) {}
        }

        @Override
        public void run() {
            try {
                socket = new ServerSocket(47123, 50, InetAddress.getByName("127.0.0.1"));
                while (running) {
                    final Socket client = socket.accept();
                    new Thread(() -> handle(client), "student-vault-http").start();
                }
            } catch (Exception ignored) {
            }
        }

        private void handle(Socket client) {
            try (Socket c = client) {
                InputStream input = new BufferedInputStream(c.getInputStream());
                ByteArrayOutputStream headerBytes = new ByteArrayOutputStream();
                int previous = -1;
                int current;
                while ((current = input.read()) != -1) {
                    headerBytes.write(current);
                    if (previous == '\r' && current == '\n') break;
                    previous = current;
                    if (headerBytes.size() > 16384) break;
                }
                String requestLine = headerBytes.toString("ISO-8859-1").split("\r\n")[0];
                String[] parts = requestLine.split(" ");
                String path = parts.length > 1 ? parts[1] : "/";
                int query = path.indexOf('?');
                if (query >= 0) path = path.substring(0, query);
                if (path.equals("/") || path.isEmpty()) path = "/index.html";
                path = path.replace("..", "");
                String assetPath = "public" + path;
                byte[] body;
                try {
                    InputStream stream = assets.open(assetPath);
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    int read;
                    while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
                    stream.close();
                    body = buffer.toByteArray();
                } catch (Exception missing) {
                    body = "Not found".getBytes(StandardCharsets.UTF_8);
                    String header = "HTTP/1.1 404 Not Found\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
                    OutputStream output = c.getOutputStream();
                    output.write(header.getBytes(StandardCharsets.ISO_8859_1));
                    output.write(body);
                    return;
                }
                String extension = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.US) : "html";
                String type = mime.getOrDefault(extension, "application/octet-stream");
                String header = "HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                OutputStream output = new BufferedOutputStream(c.getOutputStream());
                output.write(header.getBytes(StandardCharsets.ISO_8859_1));
                output.write(body);
                output.flush();
            } catch (Exception ignored) {
            }
        }
    }
}
