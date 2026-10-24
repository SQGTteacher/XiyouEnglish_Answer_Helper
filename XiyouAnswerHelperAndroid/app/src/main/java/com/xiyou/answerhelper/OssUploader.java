package com.xiyou.answerhelper;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

/**
 * 阿里云 OSS 上传（V1 签名）。
 * 凭证来自西柚 /user/getOssParam：accessKeyId / accessKeySecret / bucketName / region。
 */
public final class OssUploader {
    private final String ak;
    private final String sk;
    private final String bucket;
    private final String endpoint;

    public OssUploader(Map<String, String> p) throws Exception {
        this.ak = p.get("accessKeyId");
        this.sk = p.get("accessKeySecret");
        this.bucket = p.get("bucketName");
        String region = p.get("region");
        if (ak == null || ak.isEmpty() || sk == null || sk.isEmpty()
                || bucket == null || bucket.isEmpty() || region == null || region.isEmpty()) {
            throw new Exception("上传凭证不完整");
        }
        this.endpoint = "https://" + bucket + ".oss-" + region + ".aliyuncs.com";
    }

    /** 上传文件，返回可访问 URL */
    public String upload(String key, File file, String contentType) throws Exception {
        byte[] body = readAll(file);
        String date = rfc1123();
        String sts = "PUT\n\n" + contentType + "\n" + date + "\n/" + bucket + "/" + key;
        String sig = hmacSha1Base64(sts, sk);

        HttpsURLConnection conn = (HttpsURLConnection) new URL(endpoint + "/" + key).openConnection();
        try {
            conn.setSSLSocketFactory(insecureSsl().getSocketFactory());
            conn.setRequestMethod("PUT");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(body.length);
            conn.setRequestProperty("Date", date);
            conn.setRequestProperty("Content-Type", contentType);
            conn.setRequestProperty("Content-Length", String.valueOf(body.length));
            conn.setRequestProperty("Authorization", "OSS " + ak + ":" + sig);
            OutputStream os = conn.getOutputStream();
            os.write(body);
            os.flush();
            os.close();
            int code = conn.getResponseCode();
            if (code != 200) {
                InputStream es = conn.getErrorStream();
                String msg = es == null ? "" : new String(readAll(es), "UTF-8");
                throw new Exception("OSS 上传失败(" + code + ") " + msg.replaceAll("\\s+", " ").trim());
            }
            return endpoint + "/" + key;
        } finally {
            conn.disconnect();
        }
    }

    private static SSLContext insecureSsl() throws Exception {
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

    private static String rfc1123() {        SimpleDateFormat f = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("GMT"));
        return f.format(new Date());
    }

    private static String hmacSha1Base64(String data, String key) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA1");
        mac.init(new SecretKeySpec(key.getBytes("UTF-8"), "HmacSHA1"));
        byte[] raw = mac.doFinal(data.getBytes("UTF-8"));
        return android.util.Base64.encodeToString(raw, android.util.Base64.NO_WRAP);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    private static byte[] readAll(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        return readAll(in);
    }
}
