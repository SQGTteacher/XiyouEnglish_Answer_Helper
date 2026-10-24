package com.xiyou.answerhelper;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 本地存储：账号密码、会话、界面偏好。
 * 账号密码用 Android Keystore 的 AES-GCM 加密后落盘；设备不支持时降级为简单混淆。
 */
public final class Store {
    private static final String SP = "xiyou_helper";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "xy_helper_key";

    private final SharedPreferences sp;

    public Store(Context ctx) {
        this.sp = ctx.getApplicationContext().getSharedPreferences(SP, Context.MODE_PRIVATE);
    }

    public String get(String k, String def) {
        return sp.getString(k, def);
    }

    public boolean getBool(String k, boolean def) {
        return sp.getBoolean(k, def);
    }

    public void put(String k, String v) {
        sp.edit().putString(k, v).apply();
    }

    public void putBool(String k, boolean v) {
        sp.edit().putBoolean(k, v).apply();
    }

    public void remove(String k) {
        sp.edit().remove(k).apply();
    }

    /** 保存账号密码 */
    public void saveCredential(String account, String password) {
        put("account", account == null ? "" : account);
        put("password_enc", encrypt(password == null ? "" : password));
    }

    public String getAccount() {
        return get("account", "");
    }

    public String getPassword() {
        return decrypt(get("password_enc", ""));
    }

    public void saveSession(String sessionId, String userId, String name, String extraJson) {
        put("sessionId", sessionId == null ? "" : sessionId);
        put("userId", userId == null ? "" : userId);
        put("userName", name == null ? "" : name);
        put("userExtra", extraJson == null ? "" : extraJson);
    }

    public String getSessionId() {
        return get("sessionId", "");
    }

    public String getUserId() {
        return get("userId", "");
    }

    public String getUserName() {
        return get("userName", "");
    }

    public String getUserExtra() {
        return get("userExtra", "");
    }

    public void clearSession() {
        remove("sessionId");
        remove("userId");
        remove("userExtra");
    }

    // ---------------- 加解密 ----------------

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            return (SecretKey) ks.getKey(ALIAS, null);
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b.setKeySize(256);
        }
        kg.init(b.build());
        return kg.generateKey();
    }

    private String encrypt(String plain) {
        if (plain == null || plain.isEmpty()) return "";
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return "v1:" + Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (Throwable e) {
            return "v0:" + Base64.encodeToString(plain.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        }
    }

    private String decrypt(String stored) {
        if (stored == null || stored.isEmpty()) return "";
        try {
            if (stored.startsWith("v0:")) {
                return new String(Base64.decode(stored.substring(3), Base64.NO_WRAP), StandardCharsets.UTF_8);
            }
            if (!stored.startsWith("v1:")) return "";
            byte[] all = Base64.decode(stored.substring(3), Base64.NO_WRAP);
            int ivLen = 12;
            byte[] iv = new byte[ivLen];
            byte[] ct = new byte[all.length - ivLen];
            System.arraycopy(all, 0, iv, 0, ivLen);
            System.arraycopy(all, ivLen, ct, 0, ct.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return new String(c.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Throwable e) {
            return "";
        }
    }
}
