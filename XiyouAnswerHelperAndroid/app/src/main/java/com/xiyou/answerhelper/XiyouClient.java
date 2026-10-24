package com.xiyou.answerhelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 西柚英语接口客户端。
 *
 * 协议还原自学生端 4.8.6 前端代码：
 *   POST https://app.xiyouyingyu.com/user/login/account   form  {loginAccount, password}
 *   公共参数：appVersion/belong/device=web-pc/osVersion/release/brand/timestamp/sessionId/userId
 *   签名：sign = md5( objSort(参数) + "_Sts100#@" )，请求头带 release/device/sign/udid
 *   POST /paper/module/detail                             form  {groupId}  -> data.result 含全部答案
 */
public final class XiyouClient {
    public static final String BASE = "https://app.xiyouyingyu.com";
    private static final String MASTER = "_Sts100#@";
    private static final String RELEASE = "4.8.6";
    private static final String DEVICE = "web-pc";
    private static final String BRAND = "1.7976931348623157e+308";
    /** 电脑端 Chrome 87 UA，和 Electron 客户端一致 */
    public static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36";
    private static final String OS_VERSION =
            "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36";

    private final String udid;
    private String sessionId = "";
    private String userId = "";
    private String clazzId = "";
    private final List<String> logs = new ArrayList<>();

    public XiyouClient(String udid) {
        this.udid = udid == null ? randomUdid() : udid;
    }

    public String getUdid() {
        return udid;
    }

    public String getSessionId() {
        return sessionId;
    }

    public String getUserId() {
        return userId;
    }

    public void setSession(String sessionId, String userId) {
        setSession(sessionId, userId, "");
    }

    public void setSession(String sessionId, String userId, String clazzId) {
        this.sessionId = sessionId == null ? "" : sessionId;
        this.userId = userId == null ? "" : userId;
        this.clazzId = clazzId == null ? "" : clazzId;
    }

    public String getClazzId() {
        return clazzId;
    }

    public List<String> getLogs() {
        return new ArrayList<>(logs);
    }

    public static String randomUdid() {
        SecureRandom r = new SecureRandom();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 32; i++) sb.append("0123456789abcdef".charAt(r.nextInt(16)));
        return sb.toString();
    }

    private void log(String s) {
        logs.add(s);
        if (logs.size() > 200) logs.remove(0);
    }

    // ------------------------------------------------------------------ 登录

    /** 账号 + 密码登录（密码明文，与电脑端一致） */
    public JSONObject login(String account, String password) throws Exception {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("loginAccount", account);
        data.put("password", password);
        JSONObject resp = postForm("/user/login/account", data);
        if (isOk(resp)) {
            JSONObject d = resp.optJSONObject("data");
            JSONObject info = d == null ? null : d.optJSONObject("userInfo");
            if (info != null) {
                sessionId = info.optString("sessionId", "");
                userId = info.optString("id", "");
                clazzId = info.optString("clazzId", "");
            }
        }
        return resp;
    }

    /** 已在别处拿到 sessionId 时，验证会话是否还有效 */
    public JSONObject checkSession() throws Exception {
        return postForm("/user/selectByPrimaryKey", new LinkedHashMap<String, String>());
    }

    // ------------------------------------------------------------------ 作业

    /**
     * 拉取作业列表。返回原始响应，交由前端解析。
     * 依次尝试：作业包列表 -> 包内条目；失败再试旧版作业列表。
     */
    public JSONObject fetchHomeworkBags() throws Exception {
        if (!userId.isEmpty() && !clazzId.isEmpty()) {
            JSONArray merged = new JSONArray();
            java.util.Set<String> seen = new java.util.HashSet<>();
            boolean okAny = false;
            // 实测 homeworkStatus=1 是当前待完成，0 为今日任务；两个都拉，按 id 去重
            for (int st : new int[]{1, 0}) {
                JSONObject req = new JSONObject();
                req.put("userId", userId);
                req.put("clazzId", clazzId);
                req.put("homeworkStatus", st);
                JSONObject resp = postJson("/homework/findBagListV2", req);
                if (isOk(resp)) {
                    okAny = true;
                    JSONObject d = resp.optJSONObject("data");
                    JSONArray list = d == null ? null : d.optJSONArray("bagList");
                    if (list != null) {
                        for (int i = 0; i < list.length(); i++) {
                            JSONObject b = list.optJSONObject(i);
                            if (b == null) continue;
                            String key = b.optString("id", b.optString("name", ""));
                            if (!seen.add(key)) continue;
                            merged.put(b);
                        }
                    }
                } else {
                    log("findBagListV2 status=" + st + " state=" + state(resp) + " note=" + resp.optString("note", ""));
                }
            }
            if (okAny) {
                JSONObject data = new JSONObject();
                data.put("bagList", merged);
                JSONObject out = new JSONObject();
                out.put("state", "11");
                out.put("data", data);
                return out;
            }
        }
        return postForm("/homework/findList", new LinkedHashMap<String, String>());
    }

    public JSONObject fetchBagItems(String bagId) throws Exception {
        JSONObject req = new JSONObject();
        req.put("bagId", bagId);
        return postJson("/homework/findListByBagIdV2", req);
    }

    /** 最新作业（不区分班级），旧接口兜底 */
    public JSONObject fetchHomeworkList() throws Exception {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("pageIndex", "1");
        data.put("pageSize", "50");
        return postForm("/homework/findList", data);
    }

    // ------------------------------------------------------------------ 试卷

    /** OSS 上传凭证 */
    public Map<String, String> getOssParam() throws Exception {
        JSONObject r = postForm("/user/getOssParam", new LinkedHashMap<String, String>());
        if (!isOk(r)) throw new Exception("获取上传凭证失败：" + errorNote(r));
        JSONObject d = r.optJSONObject("data");
        if (d == null) throw new Exception("上传凭证为空");
        Map<String, String> m = new LinkedHashMap<>();
        m.put("accessKeyId", d.optString("accessKeyId", ""));
        m.put("accessKeySecret", d.optString("accessKeySecret", ""));
        m.put("bucketName", d.optString("bucketName", ""));
        m.put("region", d.optString("region", ""));
        return m;
    }

    /** 开始作答 / 取整份试卷（含答案） */
    public JSONObject fetchPaper(String groupId) throws Exception {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("groupId", groupId);
        return postForm("/paper/module/detail", data);
    }

    /** 只取试卷结构（不含答案，兜底用） */
    public JSONObject fetchPaperGroup(String groupId) throws Exception {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("groupId", groupId);
        return postForm("/paper/getPaperGroupById", data);
    }

    // ------------------------------------------------------------------ 底层

    private Map<String, String> common() {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("appVersion", "4.8.6");
        h.put("belong", "1");
        h.put("device", DEVICE);
        h.put("osVersion", OS_VERSION);
        h.put("release", RELEASE);
        h.put("brand", BRAND);
        h.put("timestamp", String.valueOf(System.currentTimeMillis()));
        if (sessionId != null && !sessionId.isEmpty()) {
            h.put("sessionId", sessionId);
            h.put("userId", userId);
        }
        return h;
    }

    private JSONObject postForm(String path, Map<String, String> data) throws Exception {
        Map<String, String> all = common();
        if (data != null) all.putAll(data);
        String sign = sign(all);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
        headers.put("release", RELEASE);
        headers.put("device", DEVICE);
        headers.put("udid", udid);
        headers.put("sign", sign);
        byte[] body = formEncode(all).getBytes(StandardCharsets.UTF_8);
        log("POST " + path + " form " + summarize(all));
        return new JSONObject(http(path, "POST", headers, body));
    }

    private JSONObject postJson(String path, JSONObject data) throws Exception {
        Map<String, String> all = common();
        if (data != null) {
            java.util.Iterator<String> it = data.keys();
            while (it.hasNext()) {
                String k = it.next();
                Object v = data.opt(k);
                all.put(k, jsString(v));
            }
        }
        String sign = sign(all);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json;charset=UTF-8");
        headers.put("release", RELEASE);
        headers.put("device", DEVICE);
        headers.put("udid", udid);
        headers.put("sign", sign);
        JSONObject body = new JSONObject();
        for (Map.Entry<String, String> e : all.entrySet()) body.put(e.getKey(), e.getValue());
        byte[] raw = body.toString().getBytes(StandardCharsets.UTF_8);
        log("POST " + path + " json " + summarize(all));
        return new JSONObject(http(path, "POST", headers, raw));
    }

    private static String summarize(Map<String, String> m) {
        StringBuilder sb = new StringBuilder("{");
        int i = 0;
        for (Map.Entry<String, String> e : m.entrySet()) {
            if (i++ > 0) sb.append(", ");
            String v = e.getValue();
            String lk = e.getKey().toLowerCase();
            if (lk.contains("password") || lk.contains("pwd")) v = "***";
            else if (v != null && v.length() > 40) v = v.substring(0, 40) + "…";
            sb.append(e.getKey()).append('=').append(v);
        }
        return sb.append('}').toString();
    }

    /** 复刻 JS 的 objSort + md5(str + masters) */
    static String sign(Map<String, String> params) throws Exception {
        List<String> keys = new ArrayList<>(params.keySet());
        Collections.sort(keys);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) sb.append('&');
            sb.append(keys.get(i)).append('=').append(params.get(keys.get(i)));
        }
        sb.append(MASTER);
        return md5(sb.toString());
    }

    static String md5(String s) throws Exception {
        MessageDigest md = MessageDigest.getInstance("MD5");
        byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    private static String jsString(Object v) {
        if (v == null || v == JSONObject.NULL) return "";
        if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d)) {
                return String.valueOf((long) d);
            }
            return String.valueOf(d);
        }
        return String.valueOf(v);
    }

    private static String formEncode(Map<String, String> m) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : m.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append(urlEnc(e.getKey())).append('=').append(urlEnc(e.getValue()));
        }
        return sb.toString();
    }

    private static String urlEnc(String s) {
        try {
            return URLEncoder.encode(s == null ? "" : s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }

    private String http(String path, String method, Map<String, String> headers, byte[] body) throws Exception {
        HttpsURLConnection conn = null;
        try {
            URL url = new URL(BASE + path);
            conn = (HttpsURLConnection) url.openConnection();
            conn.setSSLSocketFactory(insecureContext().getSocketFactory());
            conn.setHostnameVerifier(new HostnameVerifier() {
                @Override
                public boolean verify(String hostname, SSLSession session) {
                    // 客户端本身忽略证书错误，这里只对官方域名放行
                    return hostname != null && hostname.endsWith("xiyouyingyu.com");
                }
            });
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(false);
            conn.setDoInput(true);
            if (body != null) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
            }
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "application/json, text/plain, */*");
            conn.setRequestProperty("Accept-Encoding", "identity");
            conn.setRequestProperty("Origin", "https://student.xiyouyingyu.com");
            conn.setRequestProperty("Referer", "https://student.xiyouyingyu.com/");
            for (Map.Entry<String, String> e : headers.entrySet()) {
                conn.setRequestProperty(e.getKey(), e.getValue());
            }
            if (body != null) {
                OutputStream os = conn.getOutputStream();
                os.write(body);
                os.flush();
                os.close();
            }
            int code = conn.getResponseCode();
            InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(is, conn.getContentEncoding());
            log("HTTP " + code + " " + path + " <- " + (text.length() > 120 ? text.substring(0, 120) + "…" : text));
            if (code >= 400) {
                throw new IOException("HTTP " + code + "：" + text);
            }
            if (text == null || text.trim().isEmpty()) {
                throw new IOException("服务器返回空内容");
            }
            return text;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream is, String encoding) throws IOException {
        if (is == null) return "";
        if (encoding != null && encoding.toLowerCase().contains("gzip")) {
            is = new GZIPInputStream(is);
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static SSLContext insecureContext() throws Exception {
        TrustManager[] tm = new TrustManager[]{new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        }};
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tm, new SecureRandom());
        return ctx;
    }

    // ------------------------------------------------------------------ JSON 小工具

    public static String state(JSONObject o) {
        if (o == null) return "";
        Object v = o.opt("state");
        return v == null ? "" : jsString(v);
    }

    /** 尽量把服务器错误翻译成一句人话 */
    public static String errorNote(JSONObject o) {
        if (o == null) return "服务器没有响应";
        if (isOk(o)) return "";
        String note = o.optString("note", "");
        if (!note.isEmpty()) return note;
        Object status = o.opt("status");
        if (status != null) {
            JSONArray errs = o.optJSONArray("errors");
            if (errs != null && errs.length() > 0) {
                JSONObject e0 = errs.optJSONObject(0);
                if (e0 != null) {
                    String m = e0.optString("defaultMessage", "");
                    if (!m.isEmpty()) return m;
                }
            }
            return "服务器返回错误（" + jsString(status) + "）";
        }
        String st = state(o);
        if ("22".equals(st)) return "登录状态已过期，请重新登录";
        return st.isEmpty() ? "请求失败" : ("请求失败（state=" + st + "）");
    }

    public static boolean isOk(JSONObject o) {
        return "11".equals(state(o));
    }

    /** 从形如 {state,data} 的响应里取出 data，保持原类型 */
    public static Object dataOf(JSONObject o) {
        return o == null ? null : o.opt("data");
    }

    public static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", msg == null ? "未知错误" : msg);
        } catch (Exception ignored) {
        }
        return o;
    }

    public static JSONObject ok(Object data) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("data", data == null ? JSONObject.NULL : data);
        } catch (Exception ignored) {
        }
        return o;
    }
}


