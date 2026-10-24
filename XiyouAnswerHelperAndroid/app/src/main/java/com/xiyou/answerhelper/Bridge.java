package com.xiyou.answerhelper;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 前端 JS 与原生协议层的桥 */
public final class Bridge {
    private final MainActivity activity;
    private final Store store;
    private final WebView webView;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile String view = "home";
    private XiyouClient client;
    private MediaController media;
    private final Map<Integer, File> recFiles = new LinkedHashMap<>();
    private int recMark = -1;

    public Bridge(MainActivity activity, Store store, WebView webView) {
        this.activity = activity;
        this.store = store;
        this.webView = webView;
        this.client = newClient();
    }

    public void setMedia(MediaController m) {
        this.media = m;
        if (m != null) {
            m.setOnPlayDone(new Runnable() {
                @Override
                public void run() {
                    emitAudio("audioEnd", "{\"ok\":true}");
                }
            });
        }
    }

    private XiyouClient newClient() {
        String udid = store.get("udid", "");
        if (udid.isEmpty()) {
            udid = XiyouClient.randomUdid();
            store.put("udid", udid);
        }
        XiyouClient c = new XiyouClient(udid);
        c.setSession(store.getSessionId(), store.getUserId(), store.get("clazzId", ""));
        return c;
    }

    @JavascriptInterface
    public void setView(String v) {
        view = v == null ? "home" : v;
    }

    @JavascriptInterface
    public String getView() {
        return view;
    }

    @JavascriptInterface
    public void prefSet(String key, String value) {
        if ("detail".equals(key)) {
            store.putBool("detail", "1".equals(value));
        } else {
            store.put(key, value == null ? "" : value);
        }
    }

    @JavascriptInterface
    public String prefGet(String key) {
        return store.get(key, "");
    }

    @JavascriptInterface
    public void copy(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("答案", text == null ? "" : text));
            }
        } catch (Throwable ignored) {
        }
    }

    // ---------------- 作答：播放 / 录音 ----------------

    @JavascriptInterface
    public String audioPerm() {
        try {
            return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED ? "1" : "0";
        } catch (Throwable e) {
            return "0";
        }
    }

    @JavascriptInterface
    public void askAudioPerm() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                            == PackageManager.PERMISSION_GRANTED) {
                        emitAudio("permission", "{\"granted\":true}");
                    } else {
                        activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1001);
                    }
                } catch (Throwable e) {
                    emitAudio("permission", "{\"granted\":false}");
                }
            }
        });
    }

    public void onAudioPermissionResult(boolean granted) {
        emitAudio("permission", "{\"granted\":" + granted + "}");
    }

    @JavascriptInterface
    public void audio(final String action, final String arg) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (media == null) {
                        emitAudio("error", "{\"message\":\"录音模块未就绪\"}");
                        return;
                    }
                    String a = action == null ? "" : action;
                    if ("play".equals(a)) {
                        media.play(arg);
                        emitAudio("play", "{\"ok\":true}");
                    } else if ("stop".equals(a)) {
                        media.stopPlay();
                        emitAudio("stop", "{\"ok\":true}");
                    } else if ("recStart".equals(a)) {
                        int sec = 0;
                        try {
                            sec = Integer.parseInt(arg == null ? "0" : arg.trim());
                        } catch (Throwable ignored) {
                        }
                        media.startRecord(sec);
                        emitAudio("recStart", "{\"ok\":true}");
                    } else if ("recStop".equals(a)) {
                        long d = media.stopRecord();
                        if (media.hasRecord()) {
                            int idx = recMark >= 0 ? recMark : recFiles.size();
                            recFiles.put(idx, media.getRecordFile());
                        }
                        emitAudio("recStop", "{\"ok\":true,\"duration\":" + d
                                + ",\"size\":" + media.recordSize() + "}");
                    } else if ("recMark".equals(a)) {
                        try {
                            recMark = Integer.parseInt(arg == null ? "-1" : arg.trim());
                        } catch (Throwable ignored) {
                            recMark = -1;
                        }
                    } else if ("beep".equals(a)) {
                        media.beep();
                    } else if ("recPlay".equals(a)) {
                        if (media.hasRecord()) {
                            media.playFile(media.getRecordFile());
                            emitAudio("recPlay", "{\"ok\":true}");
                        } else {
                            emitAudio("recPlay", "{\"ok\":false,\"message\":\"还没有录音\"}");
                        }
                    } else if ("recStopPlay".equals(a)) {
                        media.stopPlay();
                    } else if ("stopAll".equals(a)) {
                        media.stopPlay();
                        media.stopRecord();
                        activity.stopVideo();
                    }
                } catch (Throwable e) {
                    String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                    emitAudio("error", "{\"message\":" + JSONObject.quote(msg) + "}");
                }
            }
        });
    }

    @JavascriptInterface
    public void video(final String action, final String url) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if ("play".equals(action)) activity.playVideo(url);
                    else if ("stop".equals(action)) activity.stopVideo();
                } catch (Throwable e) {
                    emitAudio("videoError", "{\"message\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
                }
            }
        });
    }

    public void onVideoEnd() {
        emitAudio("videoEnd", "{\"ok\":true}");
    }

    public void onVideoError(int what, int extra) {
        emitAudio("videoError", "{\"what\":" + what + ",\"extra\":" + extra + "}");
    }

    /** 把所有录音上传到西柚的 OSS（answer/*.wav），确认送达即结束 */
    @JavascriptInterface
    public void uploadRecords() {
        final Map<Integer, File> files = new LinkedHashMap<>(recFiles);
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    if (files.isEmpty()) {
                        emitAudio("uploadDone", "{\"total\":0}");
                        return;
                    }
                    Map<String, String> oss = client.getOssParam();
                    OssUploader up = new OssUploader(oss);
                    int total = files.size();
                    int done = 0;
                    for (Map.Entry<Integer, File> e : files.entrySet()) {
                        String key = "answer/" + System.currentTimeMillis() + "_" + done + ".wav";
                        up.upload(key, e.getValue(), "audio/wav");
                        done++;
                        emitAudio("uploadProgress", "{\"done\":" + done + ",\"total\":" + total + "}");
                    }
                    emitAudio("uploadDone", "{\"total\":" + total + "}");
                } catch (Throwable ex) {
                    String msg = ex.getClass().getSimpleName() + ": "
                            + (ex.getMessage() == null ? ex.toString() : ex.getMessage());
                    emitAudio("uploadError", "{\"message\":" + JSONObject.quote(msg) + "}");
                }
            }
        });
    }

    private void emitAudio(final String type, final String json) {
        webView.post(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.evaluateJavascript(
                            "window.__audioEvent&&window.__audioEvent(" + JSONObject.quote(type) + ","
                                    + (json == null ? "null" : json) + ")", null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    /** 启动时同步给前端的本地状态（账号、会话、偏好） */
    @JavascriptInterface
    public String initial() {        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            JSONObject data = new JSONObject();
            data.put("account", store.getAccount());
            data.put("password", store.getPassword());
            data.put("remember", !store.getAccount().isEmpty());
            data.put("hasSession", !store.getSessionId().isEmpty());
            data.put("userName", store.getUserName());
            data.put("sessionId", store.getSessionId());
            data.put("userId", store.getUserId());
            data.put("detail", store.getBool("detail", false));
            data.put("udid", store.get("udid", ""));
            data.put("version", "1.0.0");
            o.put("data", data);
        } catch (Exception e) {
            return XiyouClient.err(e.getMessage()).toString();
        }
        return o.toString();
    }

    /** 统一异步入口：JS 调 AndroidApi.call(reqId, method, argsJson)，完成后回调 __nativeResult */
    @JavascriptInterface
    public void call(final String reqId, final String method, final String argsJson) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                String result;
                try {
                    result = dispatch(method, argsJson == null ? "{}" : argsJson).toString();
                } catch (Throwable e) {
                    result = XiyouClient.err(prettyError(e)).toString();
                }
                final String payload = result;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            webView.evaluateJavascript(
                                    "window.__nativeResult(" + JSONObject.quote(reqId) + "," + payload + ")", null);
                        } catch (Throwable ignored) {
                        }
                    }
                });
            }
        });
    }

    private JSONObject dispatch(String method, String argsJson) throws Exception {
        JSONObject args = new JSONObject(argsJson.isEmpty() ? "{}" : argsJson);
        String m = method == null ? "" : method;

        if ("login".equals(m)) {
            final String account = args.optString("account", "").trim();
            final String password = args.optString("password", "");
            final boolean remember = args.optBoolean("remember", true);
            if (account.isEmpty() || password.isEmpty()) {
                return XiyouClient.err("请输入账号和密码");
            }
            client = newClient();
            JSONObject resp = client.login(account, password);
            if (!XiyouClient.isOk(resp)) {
                String note = resp.optString("note", "");
                if (note.isEmpty()) {
                    String st = XiyouClient.state(resp);
                    note = "22".equals(st) ? "登录状态已过期，请重新登录" : ("登录失败（state=" + st + "）");
                }
                JSONObject err = XiyouClient.err(note);
                JSONArray accounts = extractAccounts(resp);
                if (accounts.length() > 0) err.put("accounts", accounts);
                return err;
            }
            JSONObject data = resp.optJSONObject("data");
            JSONObject info = data == null ? null : data.optJSONObject("userInfo");
            if (info == null && data != null) info = data; // 兼容 data 直接就是 userInfo
            if (info == null) return XiyouClient.err("登录成功但未返回用户信息");

            client.setSession(info.optString("sessionId", ""), info.optString("id", ""),
                    info.optString("clazzId", ""));
            store.put("clazzId", info.optString("clazzId", ""));
            store.saveSession(client.getSessionId(), client.getUserId(),
                    info.optString("name", info.optString("realName", "")), info.toString());
            if (remember) {
                store.saveCredential(account, password);
            } else {
                store.remove("password_enc");
                store.put("account", account);
            }
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("data", userInfoForUi(info, account));
            return out;
        }

        if ("logout".equals(m)) {
            store.clearSession();
            store.remove("clazzId");
            client = newClient();
            return XiyouClient.ok(null);
        }

        if ("homeworks".equals(m)) {
            ensureSession();
            JSONObject resp = client.fetchHomeworkBags();
            JSONObject out = new JSONObject();
            out.put("ok", XiyouClient.isOk(resp));
            out.put("state", XiyouClient.state(resp));
            out.put("note", XiyouClient.errorNote(resp));
            out.put("error", XiyouClient.errorNote(resp));
            out.put("data", resp.opt("data") == null ? JSONObject.NULL : resp.opt("data"));
            out.put("debug", new JSONArray(client.getLogs()));
            return out;
        }

        if ("bagItems".equals(m)) {
            ensureSession();
            String bagId = args.optString("bagId", "");
            JSONObject resp = client.fetchBagItems(bagId);
            JSONObject out = new JSONObject();
            out.put("ok", XiyouClient.isOk(resp));
            out.put("state", XiyouClient.state(resp));
            out.put("note", XiyouClient.errorNote(resp));
            out.put("error", XiyouClient.errorNote(resp));
            out.put("data", resp.opt("data") == null ? JSONObject.NULL : resp.opt("data"));
            return out;
        }

        if ("homeworkList".equals(m)) {
            ensureSession();
            JSONObject resp = client.fetchHomeworkList();
            JSONObject out = new JSONObject();
            out.put("ok", XiyouClient.isOk(resp));
            out.put("state", XiyouClient.state(resp));
            out.put("note", XiyouClient.errorNote(resp));
            out.put("error", XiyouClient.errorNote(resp));
            out.put("data", resp.opt("data") == null ? JSONObject.NULL : resp.opt("data"));
            return out;
        }

        if ("paper".equals(m)) {
            ensureSession();
            String groupId = args.optString("groupId", "");
            if (groupId.isEmpty()) return XiyouClient.err("缺少试卷 ID");
            JSONObject resp = client.fetchPaper(groupId);
            if (!XiyouClient.isOk(resp)) {
                JSONObject out = new JSONObject();
                out.put("ok", false);
                out.put("state", XiyouClient.state(resp));
                String note = resp.optString("note", "取答案失败");
                out.put("note", note);
                out.put("error", note);
                return out;
            }
            JSONObject data = resp.optJSONObject("data");
            JSONArray result = data == null ? null : data.optJSONArray("result");
            if (result == null || result.length() == 0) {
                return XiyouClient.err("服务器没有返回试题内容");
            }
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("data", result);
            out.put("debug", new JSONArray(client.getLogs()));
            return out;
        }

        if ("logs".equals(m)) {
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("data", new JSONArray(client.getLogs()));
            return out;
        }

        return XiyouClient.err("未知操作：" + method);
    }

    private void ensureSession() throws Exception {
        if (store.getSessionId().isEmpty()) {
            throw new IllegalStateException("尚未登录");
        }
        if (client.getSessionId().isEmpty()) {
            client.setSession(store.getSessionId(), store.getUserId(), store.get("clazzId", ""));
        }
    }

    private static JSONObject userInfoForUi(JSONObject info, String account) throws Exception {
        JSONObject u = new JSONObject();
        u.put("name", info.optString("name", info.optString("realName", "")));
        u.put("userId", info.optString("id", ""));
        u.put("sessionId", info.optString("sessionId", ""));
        u.put("loginAccount", info.optString("loginAccount", account));
        u.put("schoolName", info.optString("schoolName", ""));
        u.put("className", info.optString("className", ""));
        u.put("clazzId", info.optString("clazzId", ""));
        u.put("expire", info.optString("expire", ""));
        return u;
    }

    private static JSONArray extractAccounts(JSONObject resp) {
        try {
            JSONObject d = resp.optJSONObject("data");
            JSONArray list = d == null ? null : d.optJSONArray("loginAccountList");
            if (list == null) return new JSONArray();
            JSONArray out = new JSONArray();
            for (int i = 0; i < list.length(); i++) {
                JSONObject a = list.optJSONObject(i);
                if (a == null) continue;
                JSONObject o = new JSONObject();
                o.put("loginAccount", a.optString("loginAccount", ""));
                o.put("realName", a.optString("realName", ""));
                out.put(o);
            }
            return out;
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static String prettyError(Throwable e) {
        String msg = e.getMessage() == null ? e.toString() : e.getMessage();
        String cls = e.getClass().getSimpleName();
        if (msg.contains("Unable to resolve host") || msg.contains("UnknownHost")) {
            return "无法连接服务器，请检查网络（" + msg + "）";
        }
        if (msg.contains("timeout") || msg.contains("timed out")) {
            return "连接服务器超时，请重试";
        }
        if (msg.contains("SSL") || msg.contains("Handshake")) {
            return "与服务器的安全连接失败，请稍后重试";
        }
        return cls + "：" + msg;
    }

    /** 供 UI 显示调试日志 */
    public List<String> logs() {
        return new ArrayList<>(client.getLogs());
    }
}
