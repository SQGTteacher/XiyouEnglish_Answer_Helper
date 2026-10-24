package com.xiyou.answerhelper;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.VideoView;

/** 单 Activity + 本地 WebView 界面，视频用原生 VideoView 叠在上层 */
public class MainActivity extends Activity {
    private WebView web;
    private Bridge bridge;
    private MediaController media;
    private VideoView videoView;
    private FrameLayout root;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 23) {
            getWindow().setStatusBarColor(Color.parseColor("#FFF8F3"));
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            getWindow().setNavigationBarColor(Color.parseColor("#FFFFFF"));
        }

        media = new MediaController(this);
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#FFF8F3"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadsImagesAutomatically(true);
        s.setTextZoom(100);
        // 作答流程需要自动播放音视频
        s.setMediaPlaybackRequiresUserGesture(false);
        // 电脑端 UA：西柚的作答流程按 PC 端设计
        s.setUserAgentString(XiyouClient.UA);
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        web.setWebViewClient(new WebViewClient());
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        videoView = new VideoView(this);
        videoView.setBackgroundColor(Color.BLACK);
        int vh = (int) (getResources().getDisplayMetrics().heightPixels * 0.52f);
        FrameLayout.LayoutParams vp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, vh);
        vp.gravity = Gravity.TOP;
        videoView.setLayoutParams(vp);
        videoView.setVisibility(View.GONE);
        videoView.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
            @Override
            public void onCompletion(android.media.MediaPlayer mp) {
                hideVideo();
                if (bridge != null) bridge.onVideoEnd();
            }
        });
        videoView.setOnErrorListener(new android.media.MediaPlayer.OnErrorListener() {
            @Override
            public boolean onError(android.media.MediaPlayer mp, int what, int extra) {
                hideVideo();
                if (bridge != null) bridge.onVideoError(what, extra);
                return true;
            }
        });
        root.addView(videoView);

        bridge = new Bridge(this, new Store(this), web);
        bridge.setMedia(media);
        web.addJavascriptInterface(bridge, "AndroidApi");

        setContentView(root);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    /** 播放视频（http mp4），叠加在 WebView 上方 */
    public void playVideo(final String url) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (url == null || url.isEmpty()) return;
                    media.stopPlay();
                    videoView.setVisibility(View.VISIBLE);
                    videoView.setVideoURI(Uri.parse(url));
                    videoView.setOnPreparedListener(new android.media.MediaPlayer.OnPreparedListener() {
                        @Override
                        public void onPrepared(android.media.MediaPlayer mp) {
                            try {
                                mp.setLooping(false);
                                videoView.start();
                            } catch (Throwable ignored) {
                            }
                        }
                    });
                    videoView.requestFocus();
                } catch (Throwable e) {
                    hideVideo();
                    if (bridge != null) bridge.onVideoError(-1, 0);
                }
            }
        });
    }

    public void stopVideo() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (videoView.isPlaying()) videoView.stopPlayback();
                } catch (Throwable ignored) {
                }
                hideVideo();
            }
        });
    }

    private void hideVideo() {
        try {
            videoView.setVisibility(View.GONE);
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 1001) {
            boolean granted = grantResults.length > 0 && grantResults[0] == 0;
            if (bridge != null) bridge.onAudioPermissionResult(granted);
        }
    }

    @Override
    public void onBackPressed() {
        String v = bridge == null ? "home" : bridge.getView();
        if (v == null || v.isEmpty() || "home".equals(v) || "login".equals(v)) {
            super.onBackPressed();
        } else {
            // answer / session / home-items 等子视图：交给页面自己退一层
            web.evaluateJavascript("window.__androidBack&&window.__androidBack()", null);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        try {
            if (videoView.isPlaying()) videoView.pause();
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onDestroy() {
        try {
            if (media != null) media.release();
        } catch (Throwable ignored) {
        }
        try {
            if (videoView != null) videoView.stopPlayback();
        } catch (Throwable ignored) {
        }
        try {
            if (web != null) {
                web.removeJavascriptInterface("AndroidApi");
                web.loadUrl("about:blank");
                web.destroy();
            }
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }
}
