import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Enumeration;
import java.util.stream.Stream;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * 把 aapt2 产物重新打包成规范 APK：
 *  - resources.arsc 必须 STORED（不压缩），否则 Android 11+ 安装报“无效安装包”
 *  - assets 路径统一用正斜杠（aapt2 在 Windows 下会写成反斜杠）
 *  - 所有条目预置 size/crc，避免 data descriptor
 */
public final class PackApk {
    public static void main(String[] args) throws Exception {
        Path src = Paths.get(args[0]);
        Path out = Paths.get(args[1]);
        Path dex = Paths.get(args[2]);
        Path assets = Paths.get(args[3]);

        try (ZipFile zf = new ZipFile(src.toFile());
             ZipOutputStream zo = new ZipOutputStream(new BufferedOutputStream(Files.newOutputStream(out)))) {
            zo.setLevel(9);
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String name = e.getName().replace('\\', '/');
                if (name.startsWith("assets/")) continue;
                byte[] data = readAll(zf.getInputStream(e));
                boolean store = "resources.arsc".equals(name);
                putEntry(zo, name, data, store, e.getTime());
            }
            if (Files.exists(dex)) {
                putEntry(zo, "classes.dex", Files.readAllBytes(dex), false, System.currentTimeMillis());
            }
            if (Files.isDirectory(assets)) {
                try (Stream<Path> walk = Files.walk(assets)) {
                    walk.filter(Files::isRegularFile).forEach(p -> {
                        String rel = assets.relativize(p).toString().replace('\\', '/');
                        try {
                            putEntry(zo, "assets/" + rel, Files.readAllBytes(p), false, Files.getLastModifiedTime(p).toMillis());
                        } catch (IOException ex) {
                            throw new RuntimeException(ex);
                        }
                    });
                }
            }
        }
        System.out.println("APK packed: " + out + " (" + Files.size(out) + " bytes)");
    }

    private static void putEntry(ZipOutputStream zo, String name, byte[] data, boolean store, long time) throws IOException {
        ZipEntry ne = new ZipEntry(name);
        ne.setTime(time);
        CRC32 crc = new CRC32();
        crc.update(data);
        ne.setSize(data.length);
        ne.setCrc(crc.getValue());
        if (store) {
            ne.setMethod(ZipEntry.STORED);
            ne.setCompressedSize(data.length);
        } else {
            ne.setMethod(ZipEntry.DEFLATED);
        }
        zo.putNextEntry(ne);
        zo.write(data);
        zo.closeEntry();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }
}
